#!/usr/bin/env tsx
/**
 * curvesmith: the Curvesmith toolkit from a terminal.
 *
 *   curvesmith presets                       list library templates
 *   curvesmith inspect <template|file|config> analyze, simulate and lint a preset
 *   curvesmith publish <template|file>       create the DBC config and list it (CSR-1)
 *   curvesmith list                          read the on-chain registry
 *   curvesmith launch <config> --name --symbol [--buy 0.1]
 *   curvesmith buy <pool> <amount> | sell <pool> <amount|all>
 *   curvesmith status <pool> | graduate <pool> | claim <pool>
 *   curvesmith keeper                        graduate every completed pool of listed presets
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Command } from 'commander'
import {
    Connection,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    sendAndConfirmTransaction,
    Transaction,
} from '@solana/web3.js'
import BN from 'bn.js'
import Decimal from 'decimal.js'
import { getPriceFromSqrtPrice } from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
    buildClaimTransaction,
    buildLaunchTransaction,
    buildMigrateTransaction,
    buildPublishTransactions,
    buildSnapshot,
    buildSwapTransaction,
    chainTime,
    dbcClient,
    DEFAULT_RPC,
    evaluateConfig,
    evaluatePreset,
    Evaluation,
    explorerUrl,
    fetchListings,
    LIBRARY,
    LIBRARY_IDS,
    loadPool,
    Network,
    presetStats,
    PresetSpec,
    PRESET_SCHEMA,
    quoteAssetByMint,
    quoteSwap,
    SCENARIOS,
    simulate,
    specFromConfig,
    withRetry,
} from '@curvesmith/core'

// ---------------------------------------------------------------------------------------
// plumbing
// ---------------------------------------------------------------------------------------

interface Ctx {
    network: Network
    connection: Connection
    keypairPath: string
}

const program = new Command()
program
    .name('curvesmith')
    .description('Design, simulate, publish and launch Meteora DBC presets')
    .option('-n, --network <network>', 'devnet or mainnet-beta', 'devnet')
    .option('-u, --rpc <url>', 'RPC endpoint (defaults to the public one for the network)')
    .option('-k, --keypair <path>', 'signer keypair JSON (default .keys/id.json, then ~/.config/solana/id.json)')

/** Where the user ran the command (pnpm scripts change cwd to the package; INIT_CWD keeps the original). */
const userCwd = process.env.INIT_CWD ?? process.cwd()

function ctx(): Ctx {
    const o = program.opts<{ network: string; rpc?: string; keypair?: string }>()
    const network = (o.network === 'mainnet' ? 'mainnet-beta' : o.network) as Network
    if (network !== 'devnet' && network !== 'mainnet-beta') throw new Error(`unknown network ${o.network}`)
    const local = path.resolve(userCwd, '.keys/id.json')
    const keypairPath = o.keypair ?? (fs.existsSync(local) ? local : path.join(os.homedir(), '.config/solana/id.json'))
    return { network, connection: new Connection(o.rpc ?? DEFAULT_RPC[network], 'confirmed'), keypairPath }
}

function signer(c: Ctx): Keypair {
    if (!fs.existsSync(c.keypairPath)) throw new Error(`no keypair at ${c.keypairPath}. Run "curvesmith keygen" first.`)
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(c.keypairPath, 'utf8'))))
}

async function send(c: Ctx, tx: Transaction, signers: Keypair[], label: string): Promise<string> {
    const sig = await sendAndConfirmTransaction(c.connection, tx, signers, { commitment: 'confirmed', skipPreflight: false })
    console.log(`  ${label}: ${explorerUrl(c.network, 'tx', sig)}`)
    return sig
}

function loadSpec(arg: string): PresetSpec {
    if (LIBRARY[arg]) return LIBRARY[arg]
    const file = path.resolve(userCwd, arg)
    if (fs.existsSync(file)) {
        const spec = JSON.parse(fs.readFileSync(file, 'utf8'))
        if (spec?.schema !== PRESET_SCHEMA) throw new Error(`${arg} is not a ${PRESET_SCHEMA} file`)
        return spec
    }
    throw new Error(`"${arg}" is neither a library template (${LIBRARY_IDS.join(', ')}) nor a preset file`)
}

const fmt = (x: number, d = 2) =>
    Math.abs(x) >= 10_000 ? x.toLocaleString('en-US', { maximumFractionDigits: 0 }) : x.toLocaleString('en-US', { maximumFractionDigits: d })
const pad = (s: string, n: number) => (s.length >= n ? s : s + ' '.repeat(n - s.length))

function quoteDecimalsOf(c: Ctx, mint: PublicKey) {
    return quoteAssetByMint(c.network, mint) ?? { symbol: 'quote', decimals: 9, mint }
}

function printEvaluation(ev: Evaluation, scenarioId?: string) {
    const a = ev.analyzed.analysis
    const q = a.quoteSymbol
    console.log(`\n${ev.analyzed.spec.name}  [${ev.lint.grade} ${ev.lint.score}/100]`)
    console.log(`  raise             ${fmt(a.raise)} ${q} (${fmt(a.graduationQuote)} ${q} seeds DAMM v2)`)
    console.log(`  market cap        ${fmt(a.startMcap)} -> ${fmt(a.endMcap)} ${q} (${fmt(a.maxMultiple, 1)}x)`)
    console.log(`  supply            ${fmt(a.soldPct, 1)}% sold on curve, ${fmt(a.liquidityPct, 1)}% to LP, ${fmt(a.creatorAllocationPct, 1)}% creator`)
    console.log(`  fee               ${a.fee.startBps / 100}% -> ${fmt(a.fee.endBps / 100)}%${a.fee.decaySec ? ` over ${a.fee.decaySec}s` : ''}`)
    console.log(`  curve             ${a.segments} segments, ${ev.analyzed.spec.pricing.shape.kind}`)
    console.log('\n  review')
    for (const f of ev.lint.findings) console.log(`   ${pad(`[${f.severity}]`, 11)}${f.title}`)
    const ids = scenarioId ? [scenarioId] : Object.keys(ev.runs)
    console.log('\n  simulation')
    for (const id of ids) {
        const r = ev.runs[id] ?? simulate(ev.analyzed, id)
        const sn = r.cohorts.find((x) => x.cohort === 'sniper')
        console.log(
            `   ${pad(r.scenario.name, 18)} ${r.graduated ? `graduates in ${fmt((r.graduationSec ?? 0) / 60, 1)}m` : 'does not graduate'}, ` +
                `volume ${fmt(r.volumeQuote)} ${q}, author fees ${fmt(r.fees.partner, 4)} ${q}` +
                (sn ? `, sniper ROI ${fmt(sn.roiPct, 1)}%` : '')
        )
    }
}

function run(fn: (...args: any[]) => Promise<void>) {
    return async (...args: any[]) => {
        try {
            await fn(...args)
        } catch (e) {
            const err = e as Error & { logs?: string[] }
            console.error(`\nerror: ${err.message}`)
            if (err.logs) console.error(err.logs.filter((l) => l.includes('Error')).join('\n'))
            process.exitCode = 1
        }
    }
}

// ---------------------------------------------------------------------------------------
// commands
// ---------------------------------------------------------------------------------------

program
    .command('keygen')
    .description('create .keys/id.json (never commit it)')
    .action(
        run(async () => {
            const p = path.resolve(userCwd, '.keys/id.json')
            if (fs.existsSync(p)) throw new Error(`${p} already exists`)
            fs.mkdirSync(path.dirname(p), { recursive: true })
            const kp = Keypair.generate()
            fs.writeFileSync(p, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 })
            console.log(`created ${p}\naddress ${kp.publicKey.toBase58()}`)
        })
    )

program
    .command('airdrop [sol]')
    .description('request devnet SOL for the signer')
    .action(
        run(async (sol = '1') => {
            const c = ctx()
            if (c.network !== 'devnet') throw new Error('airdrops only exist on devnet')
            const me = signer(c).publicKey
            const sig = await c.connection.requestAirdrop(me, Number(sol) * LAMPORTS_PER_SOL)
            await c.connection.confirmTransaction(sig, 'confirmed')
            console.log(`balance ${(await c.connection.getBalance(me)) / LAMPORTS_PER_SOL} SOL`)
        })
    )

program
    .command('presets')
    .description('list the library templates')
    .action(
        run(async () => {
            for (const id of LIBRARY_IDS) {
                const ev = evaluatePreset(LIBRARY[id])
                const a = ev.analyzed.analysis
                console.log(`${pad(id, 17)} ${pad(`[${ev.lint.grade}]`, 5)} raise ${pad(`${fmt(a.raise)} ${a.quoteSymbol}`, 16)} ${LIBRARY[id].tagline}`)
            }
        })
    )

program
    .command('inspect <target>')
    .description('analyze, simulate and lint a template, preset file, or any on-chain DBC config address')
    .option('-s, --scenario <id>', `one of ${SCENARIOS.map((s) => s.id).join(', ')}`)
    .option('--json', 'print the full evaluation as JSON')
    .action(
        run(async (target: string, o: { scenario?: string; json?: boolean }) => {
            let ev: Evaluation
            if (!LIBRARY[target] && !fs.existsSync(path.resolve(userCwd, target))) {
                const c = ctx()
                const config = await dbcClient(c.connection).state.getPoolConfig(new PublicKey(target))
                if (!config) throw new Error(`no DBC config at ${target}`)
                ev = evaluateConfig(specFromConfig(config, c.network), config)
            } else {
                ev = evaluatePreset(loadSpec(target))
            }
            if (o.json) {
                console.log(JSON.stringify({ analysis: ev.analyzed.analysis, lint: ev.lint, scenarios: Object.fromEntries(Object.entries(ev.runs).map(([k, r]) => [k, { graduated: r.graduated, graduationSec: r.graduationSec, volume: r.volumeQuote, fees: r.fees, cohorts: r.cohorts }])) }, null, 2))
                return
            }
            printEvaluation(ev, o.scenario)
        })
    )

program
    .command('publish <spec>')
    .description('create a DBC config you own and list it in the registry')
    .action(
        run(async (arg: string) => {
            const c = ctx()
            const me = signer(c)
            const spec = loadSpec(arg)
            const ev = evaluatePreset(spec)
            if (ev.lint.findings.some((f) => f.severity === 'critical')) throw new Error('preset has critical findings; run inspect')
            console.log(`publishing "${spec.name}" to ${c.network} as ${me.publicKey.toBase58()}`)
            const plan = await buildPublishTransactions(c.connection, c.network, me.publicKey, spec)
            await send(c, plan.createConfigTx, [me, plan.config], 'create config')
            await send(c, plan.listingTx, [me], 'registry listing')
            console.log(`config ${plan.config.publicKey.toBase58()}`)
        })
    )

program
    .command('list')
    .description('read the CSR-1 registry')
    .action(
        run(async () => {
            const c = ctx()
            const listings = await withRetry(() => fetchListings(c.connection))
            if (!listings.length) return console.log('no listings')
            for (const l of listings) {
                const st = await withRetry(() => presetStats(c.connection, l.config, l.poolConfig, quoteDecimalsOf(c, l.poolConfig.quoteMint).decimals))
                console.log(`${pad(l.meta.n, 22)} ${l.config.toBase58()}  ${st.launches} launches, ${st.graduated} graduated`)
            }
        })
    )

program
    .command('snapshot')
    .option('-o, --out <path>', 'output file', 'apps/web/public/registry-<network>.json')
    .description('write a static copy of the registry and preset stats for the web app to paint from instantly')
    .action(
        run(async (o: { out: string }) => {
            const c = ctx()
            const listings = await withRetry(() => fetchListings(c.connection))
            const raw = new Map<string, Uint8Array>()
            const infos = await c.connection.getMultipleAccountsInfo(listings.map((l) => l.config))
            infos.forEach((info, i) => info && raw.set(listings[i].config.toBase58(), info.data))
            const stats = new Map<string, Awaited<ReturnType<typeof presetStats>>>()
            for (const l of listings) {
                stats.set(l.config.toBase58(), await withRetry(() => presetStats(c.connection, l.config, l.poolConfig, quoteDecimalsOf(c, l.poolConfig.quoteMint).decimals)))
            }
            const snap = buildSnapshot(c.network, listings, raw, stats)
            const file = path.resolve(userCwd, o.out.replace('<network>', c.network))
            fs.mkdirSync(path.dirname(file), { recursive: true })
            fs.writeFileSync(file, JSON.stringify(snap))
            console.log(`wrote ${snap.listings.length} listings to ${file}`)
        })
    )

program
    .command('launch <config>')
    .requiredOption('--name <name>')
    .requiredOption('--symbol <symbol>')
    .option('--uri <uri>', 'Metaplex metadata JSON URL (name, symbol, image)', '')
    .option('--buy <amount>', 'bundled first buy in quote units', '0')
    .description('launch a token from a preset')
    .action(
        run(async (config: string, o: { name: string; symbol: string; uri: string; buy: string }) => {
            const c = ctx()
            const me = signer(c)
            const pc = await dbcClient(c.connection).state.getPoolConfig(new PublicKey(config))
            if (!pc) throw new Error('no such config')
            const q = quoteDecimalsOf(c, pc.quoteMint)
            const firstBuy = new BN(new Decimal(o.buy).mul(new Decimal(10).pow(q.decimals)).floor().toFixed())
            const { tx, baseMint, pool } = await buildLaunchTransaction(c.connection, {
                config: new PublicKey(config),
                creator: me.publicKey,
                name: o.name,
                symbol: o.symbol,
                uri: o.uri,
                firstBuy,
            })
            await send(c, tx, [me, baseMint], 'launch')
            console.log(`pool ${pool.toBase58()}\nmint ${baseMint.publicKey.toBase58()}`)
        })
    )

async function trade(side: 'buy' | 'sell', poolArg: string, amountArg: string) {
    const c = ctx()
    const me = signer(c)
    const snap = await loadPool(c.connection, new PublicKey(poolArg))
    const q = quoteDecimalsOf(c, snap.config.quoteMint)
    let amountIn: BN
    if (side === 'sell' && amountArg === 'all') {
        const accs = await c.connection.getParsedTokenAccountsByOwner(me.publicKey, { mint: snap.pool.poolState.baseMint })
        amountIn = new BN(accs.value[0]?.account.data.parsed.info.tokenAmount.amount ?? '0')
    } else {
        const dec = side === 'buy' ? q.decimals : snap.config.tokenDecimal
        amountIn = new BN(new Decimal(amountArg).mul(new Decimal(10).pow(dec)).floor().toFixed())
    }
    if (amountIn.isZero()) throw new Error('nothing to trade')
    const quote = quoteSwap(snap, side, amountIn, await chainTime(c.connection))
    const minOut = quote.outputAmount.muln(99).divn(100)
    const tx = await buildSwapTransaction(c.connection, snap, me.publicKey, side, amountIn, minOut)
    await send(c, tx, [me], side)
    const outDec = side === 'buy' ? snap.config.tokenDecimal : q.decimals
    console.log(`  received ~${fmt(new Decimal(quote.outputAmount.toString()).div(new Decimal(10).pow(outDec)).toNumber())} ${side === 'buy' ? 'tokens' : q.symbol}`)
}

program.command('buy <pool> <amount>').description('buy with quote units (partial fill at graduation)').action(run((p: string, a: string) => trade('buy', p, a)))
program.command('sell <pool> <amount>').description('sell base tokens, or "all"').action(run((p: string, a: string) => trade('sell', p, a)))

program
    .command('status <pool>')
    .description('pool progress and claimable fees')
    .action(
        run(async (poolArg: string) => {
            const c = ctx()
            const snap = await loadPool(c.connection, new PublicKey(poolArg))
            const s = snap.pool.poolState
            const q = quoteDecimalsOf(c, snap.config.quoteMint)
            const ui = (x: BN, d: number) => new Decimal(x.toString()).div(new Decimal(10).pow(d)).toNumber()
            const raised = ui(s.quoteReserve, q.decimals)
            const threshold = ui(snap.config.migrationQuoteThreshold, q.decimals)
            console.log(`pool      ${poolArg}\nmint      ${s.baseMint.toBase58()}\nconfig    ${snap.configAddress.toBase58()}`)
            console.log(`price     ${getPriceFromSqrtPrice(s.sqrtPrice, snap.config.tokenDecimal, q.decimals).toString()} ${q.symbol}`)
            console.log(`raised    ${fmt(raised, 4)} / ${fmt(threshold, 4)} ${q.symbol} (${fmt((raised / threshold) * 100, 1)}%)`)
            console.log(`state     ${s.isMigrated ? 'graduated to DAMM v2' : s.quoteReserve.gte(snap.config.migrationQuoteThreshold) ? 'complete, ready to graduate' : 'trading on curve'}`)
            console.log(`fees      author ${fmt(ui(s.partnerQuoteFee, q.decimals), 6)} ${q.symbol}, creator ${fmt(ui(s.creatorQuoteFee, q.decimals), 6)} ${q.symbol} claimable`)
        })
    )

program
    .command('graduate <pool>')
    .description('migrate a completed curve into DAMM v2 (permissionless)')
    .action(
        run(async (poolArg: string) => {
            const c = ctx()
            const me = signer(c)
            const snap = await loadPool(c.connection, new PublicKey(poolArg))
            const { tx, signers, dammPool } = await buildMigrateTransaction(c.connection, snap, me.publicKey)
            await send(c, tx, [me, ...signers], 'graduate')
            console.log(`DAMM v2 pool ${dammPool.toBase58()}`)
        })
    )

program
    .command('claim <pool>')
    .option('--as <role>', 'partner (preset author) or creator', 'partner')
    .description('claim trading fees')
    .action(
        run(async (poolArg: string, o: { as: 'partner' | 'creator' }) => {
            const c = ctx()
            const me = signer(c)
            const snap = await loadPool(c.connection, new PublicKey(poolArg))
            const tx = await buildClaimTransaction(c.connection, snap, o.as, me.publicKey)
            await send(c, tx, [me], `claim as ${o.as}`)
        })
    )

program
    .command('keeper')
    .option('--interval <sec>', 'poll interval', '30')
    .option('--once', 'single pass')
    .description('graduate every completed pool of every listed preset')
    .action(
        run(async (o: { interval: string; once?: boolean }) => {
            const c = ctx()
            const me = signer(c)
            for (;;) {
                const listings = await withRetry(() => fetchListings(c.connection))
                let cranked = 0
                for (const l of listings) {
                    const st = await withRetry(() => presetStats(c.connection, l.config, l.poolConfig, quoteDecimalsOf(c, l.poolConfig.quoteMint).decimals))
                    for (const snap of st.snapshots) {
                        const s = snap.pool.poolState
                        if (s.isMigrated || s.quoteReserve.lt(snap.config.migrationQuoteThreshold)) continue
                        try {
                            const { tx, signers } = await buildMigrateTransaction(c.connection, snap, me.publicKey)
                            await send(c, tx, [me, ...signers], `graduate ${snap.address.toBase58().slice(0, 8)} (${l.meta.n})`)
                            cranked++
                        } catch (e) {
                            console.error(`  failed ${snap.address.toBase58()}: ${(e as Error).message}`)
                        }
                    }
                }
                console.log(`${new Date().toISOString()} scanned ${listings.length} presets, graduated ${cranked}`)
                if (o.once) break
                await new Promise((r) => setTimeout(r, Number(o.interval) * 1000))
            }
        })
    )

program.parseAsync()
