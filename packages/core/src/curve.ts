/**
 * Curve compiler.
 *
 * DBC prices a launch with up to 16 constant-product segments: segment i spans
 * [sqrtP_i, sqrtP_{i+1}] with liquidity L_i. Inside a segment,
 *   base sold  = L_i * (1/sqrtP_i - 1/sqrtP_{i+1})
 *   quote paid = L_i * (sqrtP_{i+1} - sqrtP_i)
 *
 * Any monotone "price vs share of the sale" function P(x) can therefore be approximated by
 * choosing breakpoints p_j = P(x_j) and liquidity weights
 *   w_j = (x_{j+1} - x_j) / (1/sqrt(p_j) - 1/sqrt(p_{j+1}))
 * so each segment sells exactly its slice of the sale. The SDK's
 * `buildCurveWithCustomSqrtPrices` then scales the weights so the whole supply
 * (curve + graduation liquidity + vesting + leftover) adds up, and derives the raise.
 *
 * Because DBC graduates at the last breakpoint, the DAMM v2 pool always opens at exactly
 * the final curve price: there is no price gap at graduation by construction.
 */
import BN from 'bn.js'
import Decimal from 'decimal.js'
import {
    ActivationType,
    BaseFeeMode,
    buildCurveWithCustomSqrtPrices,
    CollectFeeMode,
    ConfigParameters,
    createSqrtPrices,
    DammV2BaseFeeMode,
    DammV2DynamicFeeMode,
    getDeltaAmountBaseUnsigned,
    getDeltaAmountQuoteUnsigned,
    getMigrationThresholdPrice,
    getPriceFromSqrtPrice,
    MigratedCollectFeeMode,
    MigrationFeeOption,
    MigrationOption,
    Rounding,
    TokenAuthorityOption,
    TokenDecimal,
    TokenType,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { PresetSpec, resolveEndMcap, TokenAuthority } from './preset'

export const MAX_SEGMENTS = 16
/** Share of the sale spent crossing each gap between tranches. Small, so price jumps quickly. */
const TRANCHE_JUMP_SHARE = 0.002

export interface CurvePlan {
    /** Breakpoint prices in quote per whole token, ascending, length = segments + 1. */
    prices: number[]
    /** Relative liquidity per segment, length = segments. */
    weights: number[]
    /** Target share of the curve sale at each breakpoint (0..1). */
    xs: number[]
}

export function quoteDecimals(spec: PresetSpec): number {
    return spec.quote === 'SOL' ? 9 : 6
}

function sigmoidNormalized(x: number, k: number, m: number): number {
    const s = (t: number) => 1 / (1 + Math.exp(-k * (t - m)))
    const lo = s(0)
    const hi = s(1)
    return (s(x) - lo) / (hi - lo)
}

function interpolateMultiple(points: Array<{ x: number; multiple: number }>, x: number): number {
    const pts = [...points].sort((a, b) => a.x - b.x)
    if (x <= pts[0].x) return pts[0].multiple
    for (let i = 1; i < pts.length; i++) {
        if (x <= pts[i].x) {
            const a = pts[i - 1]
            const b = pts[i]
            const t = (x - a.x) / Math.max(1e-12, b.x - a.x)
            return a.multiple + (b.multiple - a.multiple) * t
        }
    }
    return pts[pts.length - 1].multiple
}

/** Breakpoints and weights for the spec's curve shape, in UI price units. */
export function planCurve(spec: PresetSpec): CurvePlan {
    const supply = spec.token.supply
    const p0 = spec.pricing.startMcap / supply
    const p1 = resolveEndMcap(spec) / supply
    const shape = spec.pricing.shape

    let xs: number[]
    let prices: number[]

    switch (shape.kind) {
        case 'constant-product':
            xs = [0, 1]
            prices = [p0, p1]
            break
        case 'flat':
            xs = [0, 1]
            prices = [p0, p0 * (1 + shape.bandBps / 10_000)]
            break
        case 'tranches': {
            const band = 1 + shape.bandBps / 10_000
            const t = shape.tranches
            const totalShare = t.reduce((s, x) => s + x.share, 0)
            const jumps = t.length - 1
            const flatBudget = 1 - TRANCHE_JUMP_SHARE * jumps
            xs = [0]
            prices = [p0 * t[0].priceMultiple]
            let x = 0
            t.forEach((tr, i) => {
                const lo = p0 * tr.priceMultiple
                x += (tr.share / totalShare) * flatBudget
                xs.push(x)
                prices.push(lo * band)
                if (i < jumps) {
                    x += TRANCHE_JUMP_SHARE
                    xs.push(x)
                    prices.push(p0 * t[i + 1].priceMultiple)
                }
            })
            xs[xs.length - 1] = 1
            break
        }
        default: {
            const n = MAX_SEGMENTS
            xs = Array.from({ length: n + 1 }, (_, j) => j / n)
            const f = (x: number): number => {
                switch (shape.kind) {
                    case 'linear':
                        return p0 + (p1 - p0) * x
                    case 'exponential':
                        return p0 * Math.pow(p1 / p0, x)
                    case 'power':
                        return p0 + (p1 - p0) * Math.pow(x, shape.exponent)
                    case 'sigmoid':
                        return p0 + (p1 - p0) * sigmoidNormalized(x, shape.steepness, shape.midpoint)
                    case 'custom':
                        return p0 * interpolateMultiple(shape.points, x)
                }
            }
            prices = xs.map(f)
            break
        }
    }

    // DBC needs strictly ascending prices. Nudge flat stretches up by a hair (0.01%).
    for (let i = 1; i < prices.length; i++) {
        if (!(prices[i] > prices[i - 1] * 1.0001)) prices[i] = prices[i - 1] * 1.0001
    }

    const weights: number[] = []
    for (let j = 0; j < prices.length - 1; j++) {
        const dx = Math.max(1e-6, xs[j + 1] - xs[j])
        const dInvSqrt = 1 / Math.sqrt(prices[j]) - 1 / Math.sqrt(prices[j + 1])
        weights.push(dx / dInvSqrt)
    }
    // Normalise so the largest weight is 1; the SDK rescales anyway and this keeps Decimal tidy.
    const maxW = Math.max(...weights)
    return { prices, weights: weights.map((w) => w / maxW), xs }
}

const AUTHORITY: Record<TokenAuthority, TokenAuthorityOption> = {
    immutable: TokenAuthorityOption.Immutable,
    'creator-update': TokenAuthorityOption.CreatorUpdateAuthority,
    'partner-update': TokenAuthorityOption.PartnerUpdateAuthority,
    'creator-update-and-mint': TokenAuthorityOption.CreatorUpdateAndMintAuthority,
    'partner-update-and-mint': TokenAuthorityOption.PartnerUpdateAndMintAuthority,
}

const FIXED_POOL_FEE: Record<number, MigrationFeeOption> = {
    25: MigrationFeeOption.FixedBps25,
    30: MigrationFeeOption.FixedBps30,
    100: MigrationFeeOption.FixedBps100,
    200: MigrationFeeOption.FixedBps200,
    400: MigrationFeeOption.FixedBps400,
    600: MigrationFeeOption.FixedBps600,
}

function lpVestingParams(v: PresetSpec['lp']['partner']['vesting']) {
    if (!v || v.pct === 0) return undefined
    const periods = Math.max(1, Math.round(v.periods))
    return {
        vestingPercentage: v.pct,
        bpsPerPeriod: Math.floor(10_000 / periods),
        numberOfPeriods: periods,
        cliffDurationFromMigrationTime: v.cliffSeconds,
        totalDuration: Math.max(periods, v.durationSeconds),
    }
}

export interface CompiledPreset {
    params: ConfigParameters
    plan: CurvePlan
}

/**
 * PresetSpec -> the exact `ConfigParameters` the DBC `create_config` instruction takes.
 *
 * Very small prices lose precision in Q64.64, and the SDK refuses a curve whose rounding
 * error exceeds the leftover reserve. In that case the leftover is grown 10x at a time (up
 * to 0.1% of supply), which is the documented purpose of the leftover allocation.
 */
export function compilePreset(spec: PresetSpec): CompiledPreset {
    let leftover = spec.token.leftover
    const cap = Math.max(leftover, spec.token.supply * 0.001)
    for (;;) {
        try {
            return compileOnce({ ...spec, token: { ...spec.token, leftover } })
        } catch (e) {
            if (!String((e as Error).message).includes('leftOverDelta') || leftover * 10 > cap) throw e
            leftover = Math.max(1, leftover) * 10
        }
    }
}

function compileOnce(spec: PresetSpec): CompiledPreset {
    const plan = planCurve(spec)
    const baseDec = spec.token.decimals as TokenDecimal
    const quoteDec = quoteDecimals(spec) as TokenDecimal
    const sqrtPrices = createSqrtPrices(plan.prices, baseDec, quoteDec)

    const s = spec.fees.schedule
    const flatFee = s.startBps === s.endBps
    const baseFeeParams = {
        baseFeeMode: s.mode === 'linear' ? BaseFeeMode.FeeSchedulerLinear : BaseFeeMode.FeeSchedulerExponential,
        feeSchedulerParam: {
            startingFeeBps: s.startBps,
            endingFeeBps: s.endBps,
            numberOfPeriod: flatFee ? 0 : s.periods,
            totalDuration: flatFee ? 0 : s.duration,
        },
    } as const

    const pool = spec.migration.pool
    const migration =
        pool.kind === 'fixed'
            ? {
                  migrationOption: MigrationOption.MET_DAMM_V2,
                  migrationFeeOption: FIXED_POOL_FEE[pool.bps],
                  migrationFee: {
                      feePercentage: spec.migration.feePct,
                      creatorFeePercentage: spec.migration.creatorFeeSharePct,
                  },
              }
            : {
                  migrationOption: MigrationOption.MET_DAMM_V2,
                  migrationFeeOption: MigrationFeeOption.Customizable,
                  migrationFee: {
                      feePercentage: spec.migration.feePct,
                      creatorFeePercentage: spec.migration.creatorFeeSharePct,
                  },
                  migratedPoolFee: {
                      collectFeeMode:
                          pool.collect === 'quote'
                              ? MigratedCollectFeeMode.QuoteToken
                              : pool.collect === 'output'
                                ? MigratedCollectFeeMode.OutputToken
                                : MigratedCollectFeeMode.Compounding,
                      dynamicFee: pool.dynamic ? DammV2DynamicFeeMode.Enabled : DammV2DynamicFeeMode.Disabled,
                      poolFeeBps: pool.bps,
                      compoundingFeeBps: pool.collect === 'compounding' ? (pool.compoundingBps ?? 5_000) : 0,
                      ...(pool.marketCapSchedule
                          ? {
                                baseFeeMode:
                                    pool.marketCapSchedule.mode === 'linear'
                                        ? DammV2BaseFeeMode.FeeMarketCapSchedulerLinear
                                        : DammV2BaseFeeMode.FeeMarketCapSchedulerExponential,
                                marketCapFeeSchedulerParams: {
                                    endingBaseFeeBps: pool.marketCapSchedule.endBps,
                                    numberOfPeriod: pool.marketCapSchedule.periods,
                                    priceMultiple: pool.marketCapSchedule.priceMultiple,
                                    schedulerExpirationDuration: pool.marketCapSchedule.expirySeconds,
                                },
                            }
                          : {}),
                  },
              }

    const alloc = spec.creatorAllocation
    const lockedVesting =
        alloc && alloc.pct > 0
            ? {
                  totalLockedVestingAmount: Math.floor((spec.token.supply * alloc.pct) / 100),
                  numberOfVestingPeriod: Math.max(1, alloc.periods),
                  cliffUnlockAmount: Math.floor((spec.token.supply * alloc.pct * alloc.cliffUnlockPct) / 10_000),
                  totalVestingDuration: Math.max(1, alloc.durationSeconds),
                  cliffDurationFromMigrationTime: alloc.cliffSeconds,
              }
            : {
                  totalLockedVestingAmount: 0,
                  numberOfVestingPeriod: 0,
                  cliffUnlockAmount: 0,
                  totalVestingDuration: 0,
                  cliffDurationFromMigrationTime: 0,
              }

    const params = buildCurveWithCustomSqrtPrices({
        token: {
            tokenType: spec.token.standard === 'spl' ? TokenType.SPLToken : TokenType.Token2022,
            tokenBaseDecimal: baseDec,
            tokenQuoteDecimal: quoteDec,
            tokenAuthorityOption: AUTHORITY[spec.token.authority],
            totalTokenSupply: spec.token.supply,
            leftover: spec.token.leftover,
        },
        fee: {
            baseFeeParams,
            dynamicFeeEnabled: spec.fees.dynamic,
            collectFeeMode: spec.fees.collect === 'quote' ? CollectFeeMode.QuoteToken : CollectFeeMode.OutputToken,
            creatorTradingFeePercentage: spec.fees.creatorSharePct,
            poolCreationFee: spec.fees.poolCreationFeeSol,
            enableFirstSwapWithMinFee: spec.fees.firstSwapMinFee,
        },
        migration,
        liquidityDistribution: {
            partnerLiquidityPercentage: spec.lp.partner.unlocked,
            partnerPermanentLockedLiquidityPercentage: spec.lp.partner.locked,
            partnerLiquidityVestingInfoParams: lpVestingParams(spec.lp.partner.vesting),
            creatorLiquidityPercentage: spec.lp.creator.unlocked,
            creatorPermanentLockedLiquidityPercentage: spec.lp.creator.locked,
            creatorLiquidityVestingInfoParams: lpVestingParams(spec.lp.creator.vesting),
        },
        lockedVesting,
        activationType: spec.activation === 'timestamp' ? ActivationType.Timestamp : ActivationType.Slot,
        sqrtPrices,
        liquidityWeights: plan.weights,
    })

    return { params, plan }
}

// ---------------------------------------------------------------------------
// Reading a compiled curve back: sampling and headline numbers
// ---------------------------------------------------------------------------

export interface CurvePoint {
    /** Whole tokens bought from the curve so far. */
    sold: number
    /** Quote (SOL/USDC) paid into the curve so far, before fees. */
    raised: number
    /** Spot price in quote per whole token. */
    price: number
    /** Fully diluted market cap in quote. */
    mcap: number
}

export interface CurveGeometry {
    sqrtStartPrice: BN
    migrationQuoteThreshold: BN
    curve: Array<{ sqrtPrice: BN; liquidity: BN }>
    tokenDecimal: number
}

/** Works for both `ConfigParameters` (pre-publish) and a decoded on-chain `PoolConfig`. */
export function geometryOf(params: {
    sqrtStartPrice: BN
    migrationQuoteThreshold: BN
    curve: Array<{ sqrtPrice: BN; liquidity: BN }>
    tokenDecimal: number
}): CurveGeometry {
    return {
        sqrtStartPrice: params.sqrtStartPrice,
        migrationQuoteThreshold: params.migrationQuoteThreshold,
        curve: params.curve.filter((c) => !c.liquidity.isZero()),
        tokenDecimal: params.tokenDecimal,
    }
}

/**
 * Walks the curve from start to the migration price and returns evenly spaced samples.
 * Uses the SDK's fixed-point delta functions, so the sold/raised totals match the program.
 */
export function sampleCurve(
    g: CurveGeometry,
    quoteDecimals: number,
    totalSupply: number,
    samplesPerSegment = 12
): CurvePoint[] {
    const baseDec = g.tokenDecimal
    const migrationSqrt = getMigrationThresholdPrice(g.migrationQuoteThreshold, g.sqrtStartPrice, g.curve)
    const baseScale = new Decimal(10).pow(baseDec)
    const quoteScale = new Decimal(10).pow(quoteDecimals)
    const toPrice = (sp: BN) => getPriceFromSqrtPrice(sp, baseDec, quoteDecimals).toNumber()

    const points: CurvePoint[] = []
    let sold = new BN(0)
    let raised = new BN(0)
    let lower = g.sqrtStartPrice
    const push = (sp: BN) => {
        const price = toPrice(sp)
        points.push({
            sold: new Decimal(sold.toString()).div(baseScale).toNumber(),
            raised: new Decimal(raised.toString()).div(quoteScale).toNumber(),
            price,
            mcap: price * totalSupply,
        })
    }
    push(lower)
    for (const seg of g.curve) {
        const upper = BN.min(seg.sqrtPrice, migrationSqrt)
        if (upper.lte(lower)) break
        const lo = new Decimal(lower.toString())
        const hi = new Decimal(upper.toString())
        let prev = lower
        for (let k = 1; k <= samplesPerSegment; k++) {
            const next =
                k === samplesPerSegment
                    ? upper
                    : new BN(lo.mul(hi.div(lo).pow(k / samplesPerSegment)).floor().toFixed())
            if (next.lte(prev)) continue
            sold = sold.add(getDeltaAmountBaseUnsigned(prev, next, seg.liquidity, Rounding.Down))
            raised = raised.add(getDeltaAmountQuoteUnsigned(prev, next, seg.liquidity, Rounding.Up))
            prev = next
            push(next)
        }
        lower = upper
        if (upper.eq(migrationSqrt)) break
    }
    return points
}
