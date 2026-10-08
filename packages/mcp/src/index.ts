#!/usr/bin/env tsx
/**
 * Launchproof MCP server: lets AI agents design, simulate, review and launch Meteora DBC presets.
 *
 * Design rule: this server never holds or asks for private keys. Every write action returns
 * an unsigned (or partially signed, for fresh config/mint keys) base64 transaction that the
 * agent's own wallet signs and submits.
 *
 * Run: pnpm mcp      (stdio transport)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'
import { Connection, PublicKey, Transaction } from '@solana/web3.js'
import BN from 'bn.js'
import Decimal from 'decimal.js'
import { getPriceFromSqrtPrice } from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
    buildLaunchTransaction,
    auditConfig,
    buildPublishTransactions,
    buildSwapTransaction,
    chainTime,
    dbcClient,
    DEFAULT_RPC,
    Evaluation,
    evaluateConfig,
    evaluatePreset,
    fetchListings,
    LIBRARY,
    LIBRARY_IDS,
    loadPool,
    Network,
    presetStats,
    PresetSpec,
    PRESET_SCHEMA,
    requireQuoteAsset,
    quoteSwap,
    readQuoteMintDecimals,
    ScenarioResult,
    SCENARIOS,
    simulate,
    specFromConfig,
} from '@launchproof/core'

const server = new McpServer({ name: 'launchproof', version: '0.1.0' })

const networkArg = z.enum(['devnet', 'mainnet-beta']).default('devnet').describe('Solana cluster')
const presetArg = z
    .union([z.string(), z.record(z.string(), z.any())])
    .describe(`A library template id (${LIBRARY_IDS.join(', ')}) or a full PresetSpec object (schema "${PRESET_SCHEMA}")`)

const rpc = (n: Network) => new Connection(process.env[`LAUNCHPROOF_RPC_${n === 'devnet' ? 'DEVNET' : 'MAINNET'}`] ?? DEFAULT_RPC[n], 'confirmed')

function toSpec(p: string | Record<string, unknown>): PresetSpec {
    if (typeof p === 'string') {
        if (!LIBRARY[p]) throw new Error(`Unknown template "${p}". Known: ${LIBRARY_IDS.join(', ')}`)
        return LIBRARY[p]
    }
    if (p.schema !== PRESET_SCHEMA) throw new Error(`PresetSpec must have schema "${PRESET_SCHEMA}". Use get_template to see a complete example.`)
    return p as unknown as PresetSpec
}

const json = (x: unknown) => ({ content: [{ type: 'text' as const, text: JSON.stringify(x, (_, v) => (BN.isBN(v) ? v.toString() : v instanceof PublicKey ? v.toBase58() : v), 2) }] })
const fail = (e: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: (e as Error).message }] })

function summarizeRun(r: ScenarioResult) {
    return {
        scenario: r.scenario.id,
        graduated: r.graduated,
        graduationMinutes: r.graduationSec !== null ? +(r.graduationSec / 60).toFixed(1) : null,
        trades: r.trades.length,
        volume: +r.volumeQuote.toFixed(4),
        fees: Object.fromEntries(Object.entries(r.fees).map(([k, v]) => [k, +v.toFixed(6)])),
        cohorts: r.cohorts.map((c) => ({ cohort: c.cohort, wallets: c.actors, spent: +c.spentQuote.toFixed(4), feesPaid: +c.feesQuote.toFixed(4), roiPct: +c.roiPct.toFixed(1) })),
    }
}

function summarizeEvaluation(ev: Evaluation) {
    return {
        name: ev.analyzed.spec.name,
        quote: ev.analyzed.spec.quote,
        designHeuristic: { grade: ev.lint.grade, score: ev.lint.score, safetyCertificate: false },
        analysis: ev.analyzed.analysis,
        findings: ev.lint.findings,
        simulations: Object.values(ev.runs).map(summarizeRun),
    }
}

const b64 = (tx: Transaction) => tx.serialize({ requireAllSignatures: false, verifySignatures: false }).toString('base64')

const tool = (name: string, description: string, inputSchema: z.ZodRawShape, handler: (args: any) => Promise<unknown> | unknown) =>
    server.registerTool(name, { description, inputSchema }, async (args: unknown) => {
        try {
            return json(await handler(args))
        } catch (e) {
            return fail(e)
        }
    })

// ---- design & analysis (pure, no network) ---------------------------------------------------

tool('list_templates', 'List curated DBC preset templates with their raise, curve shape, and design-heuristic grade. The grade is not a safety certificate.', {}, () =>
    LIBRARY_IDS.map((id) => {
        const ev = evaluatePreset(LIBRARY[id])
        return {
            id,
            name: LIBRARY[id].name,
            category: LIBRARY[id].category,
            tagline: LIBRARY[id].tagline,
            shape: LIBRARY[id].pricing.shape.kind,
            raise: `${ev.analyzed.analysis.raise.toFixed(2)} ${LIBRARY[id].quote}`,
            grade: ev.lint.grade,
            gradeType: 'design heuristic',
        }
    })
)

tool(
    'get_template',
    'Return a full PresetSpec for a template. Edit it and pass it back to evaluate_preset or build_publish_transactions to design a custom launch.',
    { id: z.string() },
    ({ id }) => {
        if (!LIBRARY[id]) throw new Error(`Unknown template ${id}`)
        return LIBRARY[id]
    }
)

tool(
    'evaluate_preset',
    'Compile a preset to a DBC config, simulate organic and sniper-rush scenarios, and lint it. Returns headline economics, findings with severities, and a 0-100 design heuristic, not a safety score.',
    { preset: presetArg },
    ({ preset }) => summarizeEvaluation(evaluatePreset(toSpec(preset)))
)

tool(
    'simulate_preset',
    'Run one market scenario against a preset on the exact DBC pool math (verified against the program binary). Trade sizes scale with the raise, so results compare across presets.',
    { preset: presetArg, scenario: z.enum(SCENARIOS.map((s) => s.id) as [string, ...string[]]) },
    ({ preset, scenario }) => {
        const ev = evaluatePreset(toSpec(preset), [])
        const r = simulate(ev.analyzed, scenario)
        return { ...summarizeRun(r), description: r.scenario.description, migration: r.migration }
    }
)

tool(
    'compare_presets',
    'Evaluate two presets side by side under the same scenarios.',
    { a: presetArg, b: presetArg },
    ({ a, b }) => ({ a: summarizeEvaluation(evaluatePreset(toSpec(a))), b: summarizeEvaluation(evaluatePreset(toSpec(b))) })
)

// ---- chain reads ------------------------------------------------------------------------------

tool(
    'audit_config',
    'Review DBC config terms directly: quote identity, unlocked LP, residual supply after burns, mint authority, migration fees. No wallet, simulation, or safety certification.',
    { address: z.string(), network: networkArg },
    async ({ address, network }) => {
        const connection = rpc(network)
        const config = await dbcClient(connection).state.getPoolConfig(new PublicKey(address))
        if (!config) throw new Error(`No DBC config at ${address}`)
        const decimals = await readQuoteMintDecimals(connection, config.quoteMint)
        return { address, network, ...auditConfig(config, network, decimals) }
    }
)

tool(
    'inspect_config',
    'Read any DBC config account (from any launchpad) and evaluate it: rebuilt spec, economics, simulations and findings.',
    { address: z.string(), network: networkArg },
    async ({ address, network }) => {
        const connection = rpc(network)
        const config = await dbcClient(connection).state.getPoolConfig(new PublicKey(address))
        if (!config) throw new Error(`No DBC config at ${address}`)
        const spec = specFromConfig(config, network)
        return { spec, ...summarizeEvaluation(evaluateConfig(spec, config)) }
    }
)

tool(
    'list_marketplace',
    'List presets published in the on-chain Launchproof registry (CSR-1) with launch counts and graduation rates.',
    { network: networkArg },
    async ({ network }) => {
        const connection = rpc(network)
        const listings = await fetchListings(connection)
        const out = []
        for (const l of listings) {
            const q = requireQuoteAsset(network, l.poolConfig.quoteMint)
            const st = await presetStats(connection, l.config, l.poolConfig, q.decimals)
            out.push({ config: l.config, author: l.author, name: l.meta.n, tagline: l.meta.t, category: l.meta.g, launches: st.launches, graduated: st.graduated, feesGenerated: st.feesQuote })
        }
        return out
    }
)

tool('pool_status', 'Progress, price and claimable fees of a DBC pool.', { pool: z.string(), network: networkArg }, async ({ pool, network }) => {
    const snap = await loadPool(rpc(network), new PublicKey(pool))
    const s = snap.pool.poolState
    const q = requireQuoteAsset(network, snap.config.quoteMint)
    const ui = (x: BN, d: number) => new Decimal(x.toString()).div(new Decimal(10).pow(d)).toNumber()
    return {
        config: snap.configAddress,
        mint: s.baseMint,
        creator: s.creator,
        price: getPriceFromSqrtPrice(s.sqrtPrice, snap.config.tokenDecimal, q.decimals).toNumber(),
        raised: ui(s.quoteReserve, q.decimals),
        threshold: ui(snap.config.migrationQuoteThreshold, q.decimals),
        quote: q.symbol,
        state: s.isMigrated ? 'graduated' : s.quoteReserve.gte(snap.config.migrationQuoteThreshold) ? 'complete' : 'trading',
        claimable: { author: ui(s.partnerQuoteFee, q.decimals), creator: ui(s.creatorQuoteFee, q.decimals) },
    }
})

tool(
    'quote_swap',
    'Exact quote for a buy (amount in quote units) or sell (amount in tokens) on a DBC pool, using live state.',
    { pool: z.string(), side: z.enum(['buy', 'sell']), amount: z.number().positive(), network: networkArg },
    async ({ pool, side, amount, network }) => {
        const connection = rpc(network)
        const snap = await loadPool(connection, new PublicKey(pool))
        const q = requireQuoteAsset(network, snap.config.quoteMint)
        const inDec = side === 'buy' ? q.decimals : snap.config.tokenDecimal
        const outDec = side === 'buy' ? snap.config.tokenDecimal : q.decimals
        const r = quoteSwap(snap, side, new BN(new Decimal(amount).mul(new Decimal(10).pow(inDec)).floor().toFixed()), await chainTime(connection))
        return {
            out: new Decimal(r.outputAmount.toString()).div(new Decimal(10).pow(outDec)).toNumber(),
            fee: new Decimal(r.tradingFee.add(r.protocolFee).toString()).div(new Decimal(10).pow(side === 'buy' ? q.decimals : q.decimals)).toNumber(),
            partialFill: !r.amountLeft.isZero(),
        }
    }
)

// ---- writes (unsigned transactions) -----------------------------------------------------------

tool(
    'build_publish_transactions',
    'Build the two transactions that publish a preset: create_config (already co-signed by the fresh config key) and the CSR-1 registry listing. The author wallet must sign both and submit them in order. The author becomes the config fee claimer and earns partner fees from every launch.',
    { preset: presetArg, author: z.string(), network: networkArg },
    async ({ preset, author, network }) => {
        const spec = toSpec(preset)
        const ev = evaluatePreset(spec, [])
        const critical = ev.lint.findings.filter((f) => f.severity === 'critical')
        if (critical.length) throw new Error(`Preset has critical findings: ${critical.map((f) => f.title).join('; ')}`)
        const plan = await buildPublishTransactions(rpc(network), network, new PublicKey(author), spec)
        plan.createConfigTx.partialSign(plan.config)
        return { config: plan.config.publicKey, transactions: [b64(plan.createConfigTx), b64(plan.listingTx)], order: 'submit index 0, wait for confirmation, then index 1' }
    }
)

tool(
    'build_launch_transaction',
    'Build a transaction that launches a token from a preset config, optionally with a bundled first buy (quote units). Co-signed by the fresh mint key; the creator wallet signs and submits.',
    { config: z.string(), creator: z.string(), name: z.string().max(32), symbol: z.string().max(10), uri: z.string(), firstBuy: z.number().min(0).default(0), network: networkArg },
    async ({ config, creator, name, symbol, uri, firstBuy, network }) => {
        const connection = rpc(network)
        const pc = await dbcClient(connection).state.getPoolConfig(new PublicKey(config))
        if (!pc) throw new Error('No such config')
        const q = requireQuoteAsset(network, pc.quoteMint)
        const { tx, baseMint, pool } = await buildLaunchTransaction(connection, {
            config: new PublicKey(config),
            creator: new PublicKey(creator),
            name,
            symbol,
            uri,
            firstBuy: new BN(new Decimal(firstBuy).mul(new Decimal(10).pow(q.decimals)).floor().toFixed()),
        })
        tx.partialSign(baseMint)
        return { pool, mint: baseMint.publicKey, transaction: b64(tx) }
    }
)

tool(
    'build_swap_transaction',
    'Build a buy or sell on a DBC pool with slippage protection. Buys use partial fill so the final buy can complete the curve.',
    { pool: z.string(), owner: z.string(), side: z.enum(['buy', 'sell']), amount: z.number().positive(), slippageBps: z.number().int().min(1).max(5000).default(100), network: networkArg },
    async ({ pool, owner, side, amount, slippageBps, network }) => {
        const connection = rpc(network)
        const snap = await loadPool(connection, new PublicKey(pool))
        const q = requireQuoteAsset(network, snap.config.quoteMint)
        const amountIn = new BN(new Decimal(amount).mul(new Decimal(10).pow(side === 'buy' ? q.decimals : snap.config.tokenDecimal)).floor().toFixed())
        const r = quoteSwap(snap, side, amountIn, await chainTime(connection))
        const minOut = r.outputAmount.muln(10_000 - slippageBps).divn(10_000)
        const tx = await buildSwapTransaction(connection, snap, new PublicKey(owner), side, amountIn, minOut)
        return { transaction: b64(tx), expectedOut: r.outputAmount, minimumOut: minOut }
    }
)

await server.connect(new StdioServerTransport())
