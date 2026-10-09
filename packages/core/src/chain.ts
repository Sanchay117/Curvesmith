/**
 * Thin, typed wrappers over the DBC SDK for every on-chain action Launchproof performs.
 * Each builder returns unsigned transactions plus any keypairs that must co-sign, so the
 * same code serves the browser wallet, the CLI and the MCP server.
 */
import {
    Commitment,
    ComputeBudgetProgram,
    Connection,
    Keypair,
    PublicKey,
    Transaction,
} from '@solana/web3.js'
import BN from 'bn.js'
import Decimal from 'decimal.js'
import {
    DAMM_V2_MIGRATION_FEE_ADDRESS,
    deriveDammV2PoolAddress,
    deriveDbcPoolAddress,
    DynamicBondingCurveClient,
    getPriceFromSqrtPrice,
    getFeeMode,
    TradeDirection,
    PoolConfig,
    SwapMode,
    VirtualPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { compilePreset } from './curve'
import { Network, QUOTE_ASSETS } from './constants'
import { PresetSpec } from './preset'
import { listingInstructions, listingMetaFromSpec } from './registry'
import { SimPool } from './sim/pool'

export function dbcClient(connection: Connection, commitment: Commitment = 'confirmed') {
    return new DynamicBondingCurveClient(connection, commitment)
}

/** Retries rate-limited or transient RPC failures with exponential backoff; rethrows anything else. */
export async function withRetry<T>(fn: () => Promise<T>, attempts = 6, baseMs = 1000): Promise<T> {
    for (let i = 0; ; i++) {
        try {
            return await fn()
        } catch (e) {
            const msg = String((e as Error)?.message ?? e)
            if (i >= attempts - 1 || !/429|too many|timeout|timed out|fetch failed|ECONNRESET|503|502/i.test(msg)) throw e
            await new Promise((r) => setTimeout(r, baseMs * 2 ** i + Math.random() * 400))
        }
    }
}

/**
 * Adds a priority fee (and optionally a CU limit) unless the SDK already did: the runtime
 * rejects a transaction with two instructions of the same compute-budget type.
 */
function withPriority(tx: Transaction, microLamports = 50_000, units?: number): Transaction {
    const has = (discriminator: number) =>
        tx.instructions.some((ix) => ix.programId.equals(ComputeBudgetProgram.programId) && ix.data[0] === discriminator)
    const pre = []
    if (units && !has(2)) pre.push(ComputeBudgetProgram.setComputeUnitLimit({ units }))
    if (!has(3)) pre.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }))
    tx.instructions.unshift(...pre)
    return tx
}

async function finalize(connection: Connection, tx: Transaction, feePayer: PublicKey): Promise<Transaction> {
    const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
    tx.recentBlockhash = blockhash
    tx.lastValidBlockHeight = lastValidBlockHeight
    tx.feePayer = feePayer
    return tx
}

// ---- publish ---------------------------------------------------------------------------

export interface PublishPlan {
    config: Keypair
    /** create_config: must be signed by the author and the config keypair. */
    createConfigTx: Transaction
    /** CSR-1 listing: signed by the author only. */
    listingTx: Transaction
}

export async function buildPublishTransactions(
    connection: Connection,
    network: Network,
    author: PublicKey,
    spec: PresetSpec
): Promise<PublishPlan> {
    const client = dbcClient(connection)
    const { params } = compilePreset(spec)
    const config = Keypair.generate()
    const createConfigTx = await client.partner.createConfig({
        config: config.publicKey,
        feeClaimer: author,
        leftoverReceiver: author,
        payer: author,
        quoteMint: QUOTE_ASSETS[network][spec.quote].mint,
        ...params,
    })
    await finalize(connection, createConfigTx, author)
    const listingTx = new Transaction().add(...listingInstructions(author, listingMetaFromSpec(config.publicKey, spec)))
    await finalize(connection, listingTx, author)
    return { config, createConfigTx, listingTx }
}

/** List (or re-list with new copy) a config the author already owns. */
export async function buildListingTransaction(
    connection: Connection,
    author: PublicKey,
    config: PublicKey,
    spec: PresetSpec,
    delist = false
): Promise<Transaction> {
    const meta = listingMetaFromSpec(config, spec)
    const tx = new Transaction().add(...listingInstructions(author, delist ? { ...meta, x: 1 } : meta))
    return finalize(connection, tx, author)
}

// ---- launch ------------------------------------------------------------------------------

export interface LaunchParams {
    config: PublicKey
    creator: PublicKey
    name: string
    symbol: string
    uri: string
    /** Optional bundled first buy in quote lamports. */
    firstBuy?: BN
}

export async function buildLaunchTransaction(connection: Connection, p: LaunchParams) {
    const client = dbcClient(connection)
    const baseMint = Keypair.generate()
    const configState = await client.state.getPoolConfig(p.config)
    if (!configState) throw new Error(`No DBC config at ${p.config.toBase58()}`)
    const tx = await client.creator.createPoolWithFirstBuy({
        createPoolParam: {
            baseMint: baseMint.publicKey,
            config: p.config,
            name: p.name,
            symbol: p.symbol,
            uri: p.uri,
            payer: p.creator,
            poolCreator: p.creator,
        },
        firstBuyParam:
            p.firstBuy && !p.firstBuy.isZero()
                ? { buyer: p.creator, buyAmount: p.firstBuy, minimumAmountOut: new BN(0), referralTokenAccount: null }
                : undefined,
    })
    withPriority(tx, 50_000, 400_000)
    await finalize(connection, tx, p.creator)
    const pool = deriveDbcPoolAddress(configState.quoteMint, baseMint.publicKey, p.config)
    return { tx, baseMint, pool }
}

// ---- trade --------------------------------------------------------------------------------

export interface PoolSnapshot {
    address: PublicKey
    pool: VirtualPool
    config: PoolConfig
    configAddress: PublicKey
}

export async function loadPool(connection: Connection, address: PublicKey): Promise<PoolSnapshot> {
    const client = dbcClient(connection)
    const pool = await client.state.getPool(address)
    if (!pool) throw new Error(`No DBC pool at ${address.toBase58()}`)
    const config = await client.state.getPoolConfig(pool.poolState.config)
    if (!config) throw new Error(`Pool ${address.toBase58()} points at a missing config`)
    return { address, pool, config, configAddress: pool.poolState.config }
}

/** Chain "now" in the units the program uses for this pool (seconds or slots). */
export async function chainTime(connection: Connection): Promise<{ unix: number; slot: number }> {
    const slot = await connection.getSlot('confirmed')
    const unix = (await connection.getBlockTime(slot).catch(() => null)) ?? Math.floor(Date.now() / 1000)
    return { unix, slot }
}

/** Human-unit quote fields, including the actual fee asset selected by the SDK. */
export function formatSwapQuote(snap: PoolSnapshot, side: 'buy' | 'sell', result: ReturnType<typeof quoteSwap>, quoteDecimals: number) {
    const direction = side === 'buy' ? TradeDirection.QuoteToBase : TradeDirection.BaseToQuote
    const feeMode = getFeeMode(snap.config.collectFeeMode, direction, false)
    const feeDecimals = feeMode.feesOnBaseToken ? snap.config.tokenDecimal : quoteDecimals
    const outDecimals = side === 'buy' ? snap.config.tokenDecimal : quoteDecimals
    return {
        out: new Decimal(result.outputAmount.toString()).div(new Decimal(10).pow(outDecimals)).toNumber(),
        fee: new Decimal(result.tradingFee.add(result.protocolFee).toString()).div(new Decimal(10).pow(feeDecimals)).toNumber(),
        feeMint: (feeMode.feesOnBaseToken ? snap.pool.poolState.baseMint : snap.config.quoteMint).toBase58(),
        feeDecimals,
        partialFill: !result.amountLeft.isZero(),
    }
}

/**
 * Quote with Launchproof's SimPool (same math as the program) seeded from live state, so the
 * UI preview and the simulator share one code path.
 */
export function quoteSwap(snap: PoolSnapshot, side: 'buy' | 'sell', amountIn: BN, now: { unix: number; slot: number }) {
    const sim = new SimPool(snap.config, { startTime: now.unix, startSlot: now.slot })
    Object.assign(sim.pool.poolState, snap.pool.poolState)
    const r = sim.quote({ side, amountIn, mode: side === 'buy' ? 'partial-fill' : 'exact-in' }, now.unix)
    return r
}

export async function buildSwapTransaction(
    connection: Connection,
    snap: PoolSnapshot,
    owner: PublicKey,
    side: 'buy' | 'sell',
    amountIn: BN,
    minimumAmountOut: BN
) {
    const client = dbcClient(connection)
    const tx = await client.pool.swap2({
        owner,
        pool: snap.address,
        swapBaseForQuote: side === 'sell',
        referralTokenAccount: null,
        swapMode: side === 'buy' ? SwapMode.PartialFill : SwapMode.ExactIn,
        amountIn,
        minimumAmountOut,
    })
    withPriority(tx)
    return finalize(connection, tx, owner)
}

// ---- graduate ----------------------------------------------------------------------------------

export function dammConfigFor(config: PoolConfig): PublicKey {
    return DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption]
}

/** Permissionless: anyone can crank a completed curve into its DAMM v2 pool. */
export async function buildMigrateTransaction(connection: Connection, snap: PoolSnapshot, payer: PublicKey) {
    const client = dbcClient(connection)
    const dammConfig = dammConfigFor(snap.config)
    const res = await client.migration.migrateToDammV2({ payer, pool: snap.address, dammConfig })
    withPriority(res.transaction, 50_000, 800_000)
    await finalize(connection, res.transaction, payer)
    const dammPool = deriveDammV2PoolAddress(dammConfig, snap.pool.poolState.baseMint, snap.config.quoteMint)
    return {
        tx: res.transaction,
        signers: [res.firstPositionNftKeypair, res.secondPositionNftKeypair].filter(Boolean) as Keypair[],
        dammPool,
    }
}

// ---- claim -------------------------------------------------------------------------------------

export async function buildClaimTransaction(
    connection: Connection,
    snap: PoolSnapshot,
    who: 'partner' | 'creator',
    wallet: PublicKey
) {
    const client = dbcClient(connection)
    const s = snap.pool.poolState
    const tx =
        who === 'partner'
            ? await client.partner.claimPartnerTradingFee({
                  pool: snap.address,
                  feeClaimer: wallet,
                  payer: wallet,
                  maxBaseAmount: s.partnerBaseFee,
                  maxQuoteAmount: s.partnerQuoteFee,
              })
            : await client.creator.claimCreatorTradingFee({
                  pool: snap.address,
                  creator: wallet,
                  payer: wallet,
                  maxBaseAmount: s.creatorBaseFee,
                  maxQuoteAmount: s.creatorQuoteFee,
              })
    return finalize(connection, tx, wallet)
}

// ---- reading: launches per preset ----------------------------------------------------------------

export interface LaunchSummary {
    pool: PublicKey
    baseMint: PublicKey
    creator: PublicKey
    progress: number
    quoteReserve: number
    price: number
    mcap: number
    graduated: boolean
    migrated: boolean
    feesQuote: number
    /** Unclaimed fee balances (UI units) for the author (partner) and the creator. */
    claimable: { partnerQuote: number; partnerBase: number; creatorQuote: number; creatorBase: number }
}

export interface PresetStats {
    launches: number
    graduated: number
    graduationRate: number
    /** Quote currently sitting in active curves. */
    tvlQuote: number
    /** Total trading + protocol fees generated, in quote (base-side fees valued at spot). */
    feesQuote: number
    pools: LaunchSummary[]
    /** Full pool state, for building claim transactions. */
    snapshots: PoolSnapshot[]
}

export function summarizePool(
    address: PublicKey,
    pool: VirtualPool,
    config: PoolConfig,
    quoteDecimals: number,
    supply: number
): LaunchSummary {
    const s = pool.poolState
    const qScale = new Decimal(10).pow(quoteDecimals)
    const bScale = new Decimal(10).pow(config.tokenDecimal)
    const q = (x: BN) => new Decimal(x.toString()).div(qScale).toNumber()
    const price = getPriceFromSqrtPrice(s.sqrtPrice, config.tokenDecimal, quoteDecimals).toNumber()
    const baseFees = new Decimal(s.metrics.totalTradingBaseFee.add(s.metrics.totalProtocolBaseFee).toString()).div(bScale).toNumber()
    const threshold = q(config.migrationQuoteThreshold)
    return {
        pool: address,
        baseMint: s.baseMint,
        creator: s.creator,
        progress: Math.min(1, q(s.quoteReserve) / threshold),
        quoteReserve: q(s.quoteReserve),
        price,
        mcap: price * supply,
        graduated: s.quoteReserve.gte(config.migrationQuoteThreshold),
        migrated: s.isMigrated === 1,
        feesQuote: q(s.metrics.totalTradingQuoteFee.add(s.metrics.totalProtocolQuoteFee)) + baseFees * price,
        claimable: {
            partnerQuote: q(s.partnerQuoteFee),
            partnerBase: new Decimal(s.partnerBaseFee.toString()).div(bScale).toNumber(),
            creatorQuote: q(s.creatorQuoteFee),
            creatorBase: new Decimal(s.creatorBaseFee.toString()).div(bScale).toNumber(),
        },
    }
}

/** Pools a wallet created, with their configs, for the creator earnings view. */
export async function poolsByCreator(connection: Connection, creator: PublicKey) {
    const client = dbcClient(connection)
    const pools = await client.state.getPoolsByCreator(creator)
    const configs = new Map<string, PoolConfig>()
    for (const p of pools) {
        const key = p.account.poolState.config.toBase58()
        if (!configs.has(key)) {
            const c = await client.state.getPoolConfig(p.account.poolState.config)
            if (c) configs.set(key, c)
        }
    }
    return pools
        .filter((p) => configs.has(p.account.poolState.config.toBase58()))
        .map((p) => ({
            address: p.publicKey,
            pool: p.account,
            config: configs.get(p.account.poolState.config.toBase58())!,
            configAddress: p.account.poolState.config,
        })) as PoolSnapshot[]
}

export async function presetStats(
    connection: Connection,
    config: PublicKey,
    poolConfig: PoolConfig,
    quoteDecimals: number
): Promise<PresetStats> {
    const client = dbcClient(connection)
    const pools = await client.state.getPoolsByConfig(config)
    const supply = new Decimal(poolConfig.preMigrationTokenSupply.toString())
        .div(new Decimal(10).pow(poolConfig.tokenDecimal))
        .toNumber()
    const summaries = pools
        .map((p) => summarizePool(p.publicKey, p.account, poolConfig, quoteDecimals, supply))
        .sort((a, b) => b.progress - a.progress)
    const graduated = summaries.filter((s) => s.graduated).length
    return {
        launches: summaries.length,
        graduated,
        graduationRate: summaries.length ? graduated / summaries.length : 0,
        tvlQuote: summaries.filter((s) => !s.migrated).reduce((a, s) => a + s.quoteReserve, 0),
        feesQuote: summaries.reduce((a, s) => a + s.feesQuote, 0),
        pools: summaries,
        snapshots: pools.map((p) => ({ address: p.publicKey, pool: p.account, config: poolConfig, configAddress: config })),
    }
}

// ---- token metadata (Metaplex) ---------------------------------------------------------------------

const METAPLEX = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')

export interface TokenMeta {
    name: string
    symbol: string
    uri: string
}

export function metadataAddress(mint: PublicKey): PublicKey {
    return PublicKey.findProgramAddressSync(
        [Buffer.from('metadata'), METAPLEX.toBuffer(), mint.toBuffer()],
        METAPLEX
    )[0]
}

/** Minimal Metaplex metadata decode: key(1) + update_authority(32) + mint(32) + 3 borsh strings. */
export function decodeTokenMeta(data: Buffer): TokenMeta {
    let o = 1 + 32 + 32
    const str = () => {
        const len = data.readUInt32LE(o)
        o += 4
        const s = data.subarray(o, o + len).toString('utf8').replace(/\0/g, '').trim()
        o += len
        return s
    }
    return { name: str(), symbol: str(), uri: str() }
}

export async function fetchTokenMetas(connection: Connection, mints: PublicKey[]): Promise<Map<string, TokenMeta>> {
    const out = new Map<string, TokenMeta>()
    for (let i = 0; i < mints.length; i += 100) {
        const chunk = mints.slice(i, i + 100)
        const infos = await connection.getMultipleAccountsInfo(chunk.map(metadataAddress))
        infos.forEach((info, j) => {
            if (!info) return
            try {
                out.set(chunk[j].toBase58(), decodeTokenMeta(info.data))
            } catch {
                /* malformed metadata: skip */
            }
        })
    }
    return out
}
