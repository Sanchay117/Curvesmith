/**
 * CSR-1: the Curve Spec Registry. A marketplace index that lives entirely on Solana.
 *
 * Listing a preset = one small transaction signed by the preset's author with:
 *   1. an SPL Memo `csr1:{json}` carrying the design intent (name, story, curve shape), and
 *   2. a 0-lamport transfer to REGISTRY_ADDRESS, so the transaction is indexed under it.
 *
 * Reading the marketplace = `getSignaturesForAddress(REGISTRY_ADDRESS)` + the memos.
 * Economics are never trusted from the memo: every listing is joined with the real DBC
 * config account, and kept only if the signer is that config's `feeClaimer`. So only the
 * party that actually earns the preset's fees can list it, and nobody can misdescribe a
 * config's fees, curve or liquidity terms: those come straight from chain.
 *
 * Trade-off: no custom program to deploy or audit, and no server, at the cost of O(n)
 * reads per refresh. Good to thousands of listings; beyond that, a cache would sit in front.
 */
import {
    ComputeBudgetProgram,
    ConfirmedSignatureInfo,
    Connection,
    ParsedTransactionWithMeta,
    PublicKey,
    SystemProgram,
    TransactionInstruction,
} from '@solana/web3.js'
import BN from 'bn.js'
import Decimal from 'decimal.js'
import {
    BaseFeeMode,
    createDbcProgram,
    getPriceFromSqrtPrice,
    PoolConfig,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { DBC_PROGRAM_ID, MEMO_PROGRAM_ID, Network, quoteAssetByMint, REGISTRY_ADDRESS, REGISTRY_MEMO_PREFIX } from './constants'
import { CurveShape, LpVesting, PresetCategory, PresetSpec, PRESET_SCHEMA, TokenAuthority } from './preset'
import { baseFeeBpsAt } from './sim/scenario'
import { initialBaseSupply } from './sim/pool'

export interface ListingMeta {
    v: 1
    /** DBC config address being listed. */
    c: string
    /** name, tagline, description */
    n: string
    t: string
    d: string
    /** category and tags */
    g: PresetCategory
    k: string[]
    /** designed curve shape (the chain only stores the compiled breakpoints) */
    s: CurveShape
    /** set to 1 to delist */
    x?: 1
}

export interface Listing {
    config: PublicKey
    author: PublicKey
    signature: string
    blockTime: number | null
    meta: ListingMeta
    poolConfig: PoolConfig
}

/** Bounds keep any listing inside one 1232-byte transaction (checked in test/core.test.ts). */
const LIMITS = { name: 48, tagline: 96, description: 420, tags: 6, tag: 20 }

export function encodeListing(meta: ListingMeta): string {
    const clean: ListingMeta = {
        v: 1,
        c: meta.c,
        n: meta.n.slice(0, LIMITS.name),
        t: meta.t.slice(0, LIMITS.tagline),
        d: meta.d.slice(0, LIMITS.description),
        g: meta.g,
        k: meta.k.slice(0, LIMITS.tags).map((x) => x.slice(0, LIMITS.tag)),
        s: meta.s,
        ...(meta.x ? { x: 1 as const } : {}),
    }
    return REGISTRY_MEMO_PREFIX + JSON.stringify(clean)
}

export function decodeListing(memo: string): ListingMeta | null {
    // jsonParsed memos may arrive as "[len] text" on some RPCs; tolerate a leading length tag.
    const at = memo.indexOf(REGISTRY_MEMO_PREFIX)
    if (at < 0) return null
    try {
        const m = JSON.parse(memo.slice(at + REGISTRY_MEMO_PREFIX.length))
        if (m?.v !== 1 || typeof m.c !== 'string' || typeof m.n !== 'string' || !m.s?.kind) return null
        new PublicKey(m.c)
        return {
            v: 1,
            c: m.c,
            n: String(m.n).slice(0, LIMITS.name),
            t: String(m.t ?? '').slice(0, LIMITS.tagline),
            d: String(m.d ?? '').slice(0, LIMITS.description),
            g: m.g ?? 'experimental',
            k: Array.isArray(m.k) ? m.k.map(String).slice(0, LIMITS.tags) : [],
            s: m.s,
            ...(m.x ? { x: 1 as const } : {}),
        }
    } catch {
        return null
    }
}

/**
 * SPL Memo logs the whole memo, costing ~380 CU per byte (measured on devnet: 506 bytes used
 * 192,756 CU), so long listings exceed the default 200k budget. Request what the memo needs.
 */
export function listingComputeUnits(memoBytes: number): number {
    return Math.min(1_400_000, 40_000 + memoBytes * 420)
}

export function listingInstructions(author: PublicKey, meta: ListingMeta): TransactionInstruction[] {
    const memo = Buffer.from(encodeListing(meta), 'utf8')
    return [
        ComputeBudgetProgram.setComputeUnitLimit({ units: listingComputeUnits(memo.length) }),
        new TransactionInstruction({
            programId: MEMO_PROGRAM_ID,
            // the author is attached as a signer so the memo program itself attests authorship
            keys: [{ pubkey: author, isSigner: true, isWritable: false }],
            data: memo,
        }),
        SystemProgram.transfer({ fromPubkey: author, toPubkey: REGISTRY_ADDRESS, lamports: 0 }),
    ]
}

export function listingMetaFromSpec(config: PublicKey, spec: PresetSpec): ListingMeta {
    return {
        v: 1,
        c: config.toBase58(),
        n: spec.name,
        t: spec.tagline,
        d: spec.description,
        g: spec.category,
        k: spec.tags,
        s: spec.pricing.shape,
    }
}

function memoOf(tx: ParsedTransactionWithMeta): string | null {
    for (const ix of tx.transaction.message.instructions) {
        if (ix.programId.equals(MEMO_PROGRAM_ID) && 'parsed' in ix && typeof ix.parsed === 'string') {
            return ix.parsed
        }
    }
    return null
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const TX_OPTS = { maxSupportedTransactionVersion: 0, commitment: 'confirmed' } as const

/** One transaction, retried with backoff: a rate-limited RPC must not silently drop a listing. */
async function fetchOne(connection: Connection, sig: string): Promise<ParsedTransactionWithMeta | null> {
    for (let attempt = 0; attempt < 5; attempt++) {
        try {
            const tx = await connection.getParsedTransaction(sig, TX_OPTS)
            if (tx) return tx
        } catch {
            /* 429 or transient error: back off and retry */
        }
        await sleep(400 * 2 ** attempt)
    }
    return null
}

async function fetchParsed(connection: Connection, sigs: string[]): Promise<(ParsedTransactionWithMeta | null)[]> {
    const out: (ParsedTransactionWithMeta | null)[] = []
    for (let i = 0; i < sigs.length; i += 25) {
        const chunk = sigs.slice(i, i + 25)
        let got: (ParsedTransactionWithMeta | null)[]
        try {
            got = await connection.getParsedTransactions(chunk, TX_OPTS)
        } catch {
            // the batch failed as a whole (rate limit, or an RPC that rejects batches)
            got = chunk.map(() => null)
        }
        // anything missing is fetched on its own, with retries
        for (let j = 0; j < chunk.length; j++) if (!got[j]) got[j] = await fetchOne(connection, chunk[j])
        out.push(...got)
    }
    return out
}

export async function fetchListings(connection: Connection, opts: { max?: number } = {}): Promise<Listing[]> {
    const max = opts.max ?? 1000
    const sigs: ConfirmedSignatureInfo[] = []
    let before: string | undefined
    while (sigs.length < max) {
        const page = await connection.getSignaturesForAddress(REGISTRY_ADDRESS, { before, limit: Math.min(1000, max - sigs.length) })
        sigs.push(...page)
        if (page.length < 1000) break
        before = page[page.length - 1].signature
    }
    const ok = sigs.filter((s) => s.err === null)
    const txs = (await fetchParsed(connection, ok.map((s) => s.signature))).filter(
        (tx): tx is ParsedTransactionWithMeta => !!tx && !tx.meta?.err
    )
    // JSON-RPC batch responses may arrive in any order, so never pair a response with its
    // request by index: read the signature from the transaction itself and order by slot.
    txs.sort((a, b) => b.slot - a.slot)

    // newest first, so the first listing seen for a config is its current state
    const latest = new Map<string, { meta: ListingMeta; author: PublicKey; signature: string; blockTime: number | null }>()
    for (const tx of txs) {
        const memo = memoOf(tx)
        if (!memo) continue
        const meta = decodeListing(memo)
        if (!meta) continue
        const author = tx.transaction.message.accountKeys.find((k) => k.signer)?.pubkey
        if (!author) continue
        const key = `${meta.c}:${author.toBase58()}`
        if (!latest.has(key)) latest.set(key, { meta, author, signature: tx.transaction.signatures[0], blockTime: tx.blockTime ?? null })
    }

    const candidates = [...latest.values()].filter((l) => !l.meta.x)
    if (candidates.length === 0) return []
    const { program } = createDbcProgram(connection)
    const accounts: (Awaited<ReturnType<Connection['getMultipleAccountsInfo']>>[number])[] = []
    for (let i = 0; i < candidates.length; i += 100) {
        accounts.push(
            ...(await connection.getMultipleAccountsInfo(candidates.slice(i, i + 100).map((c) => new PublicKey(c.meta.c))))
        )
    }

    const listings: Listing[] = []
    candidates.forEach((c, i) => {
        const acc = accounts[i]
        if (!acc || !acc.owner.equals(DBC_PROGRAM_ID)) return
        let poolConfig: PoolConfig
        try {
            poolConfig = program.coder.accounts.decode('poolConfig', acc.data) as PoolConfig
        } catch {
            return
        }
        // the trust rule: only the config's fee claimer may list it
        if (!poolConfig.feeClaimer.equals(c.author)) return
        listings.push({
            config: new PublicKey(c.meta.c),
            author: c.author,
            signature: c.signature,
            blockTime: c.blockTime,
            meta: c.meta,
            poolConfig,
        })
    })
    return listings
}

// ---------------------------------------------------------------------------------------
// Rebuilding a PresetSpec from chain: economics from the config, intent from the memo
// ---------------------------------------------------------------------------------------

const AUTHORITY_BY_CODE: TokenAuthority[] = [
    'creator-update',
    'immutable',
    'partner-update',
    'creator-update-and-mint',
    'partner-update-and-mint',
]
const FIXED_BPS = [25, 30, 100, 200, 400, 600] as const

function lpVestingFrom(v: PoolConfig['partnerLiquidityVestingInfo']): LpVesting | undefined {
    if (!v.isInitialized || v.vestingPercentage === 0) return undefined
    return {
        pct: v.vestingPercentage,
        cliffSeconds: v.cliffDurationFromMigrationTime,
        periods: v.numberOfPeriods,
        durationSeconds: v.numberOfPeriods * v.frequency,
    }
}

export function specFromConfig(
    config: PoolConfig,
    network: Network,
    intent?: Partial<Pick<ListingMeta, 'n' | 't' | 'd' | 'g' | 'k' | 's'>>
): PresetSpec {
    const asset = quoteAssetByMint(network, config.quoteMint)
    if (!asset) throw new Error(`Unsupported quote mint ${config.quoteMint.toBase58()}. Use the configuration audit for custom quote assets; they must not be treated as SOL.`)
    if (config.migrationOption !== 1) throw new Error('The Studio simulation supports DAMM v2 configs. Use the configuration audit for DAMM v1.')
    if (config.poolFees.baseFee.baseFeeMode > 1) throw new Error('The Studio simulation supports time-based fees. Use the configuration audit for other fee modes.')
    const quote = asset.symbol as 'SOL' | 'USDC'
    const qDec = quote === 'SOL' ? 9 : 6
    const dec = config.tokenDecimal as 6 | 9
    const supplyRaw = initialBaseSupply(config)
    const supply = new Decimal(supplyRaw.toString()).div(new Decimal(10).pow(dec)).toNumber()
    const price = (sp: BN) => getPriceFromSqrtPrice(sp, dec, qDec).toNumber()
    const bf = config.poolFees.baseFee
    const periods = bf.firstFactor
    const startBps = bf.cliffFeeNumerator.toNumber() / 1e5
    const endBps = baseFeeBpsAt(config, 10 * 365 * 86_400)
    const lv = config.lockedVestingConfig
    const lockedTotal = lv.amountPerPeriod.mul(lv.numberOfPeriod).add(lv.cliffUnlockAmount)
    const lockedTokens = new Decimal(lockedTotal.toString()).div(new Decimal(10).pow(dec)).toNumber()
    const pool: PresetSpec['migration']['pool'] =
        config.migrationFeeOption < 6
            ? { kind: 'fixed', bps: FIXED_BPS[config.migrationFeeOption] }
            : {
                  kind: 'custom',
                  bps: config.migratedPoolFeeBps,
                  dynamic: config.migratedDynamicFee === 1,
                  collect: (['quote', 'output', 'compounding'] as const)[config.migratedCollectFeeMode] ?? 'quote',
                  compoundingBps: config.migratedCompoundingFeeBps || undefined,
              }
    return {
        schema: PRESET_SCHEMA,
        name: intent?.n ?? 'Imported config',
        tagline: intent?.t ?? '',
        description: intent?.d ?? '',
        category: intent?.g ?? 'experimental',
        tags: intent?.k ?? [],
        quote,
        activation: config.activationType === 1 ? 'timestamp' : 'slot',
        token: {
            decimals: dec,
            supply,
            standard: config.tokenType === 0 ? 'spl' : 'token2022',
            authority: AUTHORITY_BY_CODE[config.tokenUpdateAuthority] ?? 'immutable',
            leftover: 10,
        },
        pricing: {
            startMcap: price(config.sqrtStartPrice) * supply,
            endMcap: price(config.migrationSqrtPrice) * supply,
            shape: intent?.s ?? { kind: 'constant-product' },
        },
        fees: {
            schedule: {
                mode: bf.baseFeeMode === BaseFeeMode.FeeSchedulerLinear ? 'linear' : 'exponential',
                startBps,
                endBps: periods === 0 ? startBps : Math.round(endBps),
                duration: periods === 0 ? 0 : periods * bf.secondFactor.toNumber(),
                periods,
            },
            dynamic: config.poolFees.dynamicFee.initialized === 1,
            collect: config.collectFeeMode === 0 ? 'quote' : 'output',
            creatorSharePct: config.creatorTradingFeePercentage,
            poolCreationFeeSol: config.poolCreationFee.toNumber() / 1e9,
            firstSwapMinFee: config.enableFirstSwapWithMinFee === 1,
        },
        migration: {
            pool,
            feePct: config.migrationFeePercentage,
            creatorFeeSharePct: config.creatorMigrationFeePercentage,
        },
        lp: {
            partner: {
                unlocked: config.partnerLiquidityPercentage,
                locked: config.partnerPermanentLockedLiquidityPercentage,
                vesting: lpVestingFrom(config.partnerLiquidityVestingInfo),
            },
            creator: {
                unlocked: config.creatorLiquidityPercentage,
                locked: config.creatorPermanentLockedLiquidityPercentage,
                vesting: lpVestingFrom(config.creatorLiquidityVestingInfo),
            },
        },
        creatorAllocation:
            lockedTokens > 0
                ? {
                      pct: (lockedTokens / supply) * 100,
                      cliffSeconds: lv.cliffDurationFromMigrationTime.toNumber(),
                      cliffUnlockPct: lockedTotal.isZero() ? 0 : lv.cliffUnlockAmount.muln(100).div(lockedTotal).toNumber(),
                      periods: lv.numberOfPeriod.toNumber(),
                      durationSeconds: lv.numberOfPeriod.mul(lv.frequency).toNumber(),
                  }
                : undefined,
    }
}
