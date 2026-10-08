/**
 * One-call analysis of a preset: compile it, derive the on-chain config, sample the curve,
 * and compute the headline numbers a launch designer cares about.
 */
import BN from 'bn.js'
import Decimal from 'decimal.js'
import { PublicKey } from '@solana/web3.js'
import { ConfigParameters, getPriceFromSqrtPrice, PoolConfig } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { compilePreset, CurvePlan, CurvePoint, geometryOf, quoteDecimals, sampleCurve } from './curve'
import { deriveConfigState, migrationQuoteAmount } from './onchain'
import { PresetSpec } from './preset'
import { baseFeeBpsAt } from './sim/scenario'
import { residualSupply } from './audit'

export interface PresetAnalysis {
    quoteSymbol: string
    supply: number
    /** Quote the curve must collect to graduate (the "raise"). */
    raise: number
    startPrice: number
    endPrice: number
    startMcap: number
    endMcap: number
    /** Tokens bought from the curve by the time it graduates. */
    soldOnCurve: number
    soldPct: number
    /** Tokens paired with the raise in the DAMM v2 pool. */
    toLiquidity: number
    liquidityPct: number
    creatorAllocationPct: number
    /** Tokens neither sold nor paired: unused buffer, returned to the leftover receiver. */
    leftover: number
    leftoverPct: number
    burnedPct: number
    /** Quote side of the graduated pool. */
    graduationQuote: number
    /** Average price paid on the curve, and the multiple the average buyer sits at on graduation. */
    avgPrice: number
    avgBuyerMultiple: number
    /** End price / start price: the best case for the very first buyer. */
    maxMultiple: number
    /** Price move from a buy of 1% of the raise at the very start. */
    openingImpactPct: number
    /** Reference trade size used for post-graduation impact: 1 SOL or 1,000 USDC. */
    refTrade: number
    /** Price move on the graduated DAMM v2 pool from one reference trade. */
    graduatedImpactPct: number
    fee: { startBps: number; endBps: number; decaySec: number }
    segments: number
}

export interface AnalyzedPreset {
    spec: PresetSpec
    /** Present for designs compiled locally; absent when analyzing a config read from chain. */
    params?: ConfigParameters
    plan?: CurvePlan
    config: PoolConfig
    curve: CurvePoint[]
    feeCurve: Array<{ t: number; bps: number }>
    analysis: PresetAnalysis
}

const PLACEHOLDER = PublicKey.default

export function analyzePreset(spec: PresetSpec, accounts?: { quoteMint: PublicKey; feeClaimer: PublicKey; leftoverReceiver: PublicKey }): AnalyzedPreset {
    const { params, plan } = compilePreset(spec)
    const config = deriveConfigState(
        params,
        accounts ?? { quoteMint: PLACEHOLDER, feeClaimer: PLACEHOLDER, leftoverReceiver: PLACEHOLDER }
    )
    return analyzeConfig(spec, config, params, plan)
}

/** Analyze a config as it exists on chain (spec rebuilt via `specFromConfig`). */
export function analyzeConfig(
    spec: PresetSpec,
    config: PoolConfig,
    params?: ConfigParameters,
    plan?: CurvePlan
): AnalyzedPreset {
    const qDec = quoteDecimals(spec)
    const curve = sampleCurve(geometryOf(config), qDec, spec.token.supply)
    const analysis = computeAnalysis(config, curve, {
        supply: spec.token.supply,
        quoteDecimals: qDec,
        quoteSymbol: spec.quote,
        creatorAllocationPct: spec.creatorAllocation?.pct ?? 0,
        feeDecaySec: spec.fees.schedule.startBps === spec.fees.schedule.endBps ? 0 : spec.fees.schedule.duration,
    })
    const horizon = Math.max(60, analysis.fee.decaySec * 1.5)
    const feeCurve = Array.from({ length: 61 }, (_, i) => {
        const t = (horizon * i) / 60
        return { t, bps: baseFeeBpsAt(config, t) }
    })
    return { spec, params, plan, config, curve, feeCurve, analysis }
}

export function computeAnalysis(
    config: PoolConfig,
    curve: CurvePoint[],
    o: { supply: number; quoteDecimals: number; quoteSymbol: string; creatorAllocationPct: number; feeDecaySec: number }
): PresetAnalysis {
    const bDec = config.tokenDecimal
    const qScale = new Decimal(10).pow(o.quoteDecimals)
    const bScale = new Decimal(10).pow(bDec)
    const toQ = (x: BN) => new Decimal(x.toString()).div(qScale).toNumber()
    const toB = (x: BN) => new Decimal(x.toString()).div(bScale).toNumber()
    const price = (sp: BN) => getPriceFromSqrtPrice(sp, bDec, o.quoteDecimals).toNumber()

    const raise = toQ(config.migrationQuoteThreshold)
    const startPrice = price(config.sqrtStartPrice)
    const endPrice = price(config.migrationSqrtPrice)
    const sold = toB(config.swapBaseAmount)
    const toLiquidity = toB(config.migrationBaseThreshold)
    const lv = config.lockedVestingConfig
    const vesting = toB(lv.amountPerPeriod.mul(lv.numberOfPeriod).add(lv.cliffUnlockAmount))
    const residual = residualSupply(config)
    const leftover = toB(residual.leftover)
    const graduationQuote = toQ(migrationQuoteAmount(config.migrationQuoteThreshold, config.migrationFeePercentage))

    // opening impact: walk the sampled curve to 1% of the raise
    const target = raise * 0.01
    const idx = curve.findIndex((p) => p.raised >= target)
    const openingPrice = idx > 0 ? curve[idx].price : endPrice
    const openingImpactPct = (openingPrice / startPrice - 1) * 100

    // full-range constant product after graduation: price scales with (1 + dq/Q)^2
    const refTrade = o.quoteSymbol === 'USDC' ? 1_000 : 1
    const graduatedImpactPct = (Math.pow(1 + refTrade / graduationQuote, 2) - 1) * 100

    const avgPrice = sold > 0 ? raise / sold : 0
    const startBps = config.poolFees.baseFee.cliffFeeNumerator.toNumber() / 1e5
    const endBps = baseFeeBpsAt(config, 10 * 365 * 86_400)

    return {
        quoteSymbol: o.quoteSymbol,
        supply: o.supply,
        raise,
        startPrice,
        endPrice,
        startMcap: startPrice * o.supply,
        endMcap: endPrice * o.supply,
        soldOnCurve: sold,
        soldPct: (sold / o.supply) * 100,
        toLiquidity,
        liquidityPct: (toLiquidity / o.supply) * 100,
        creatorAllocationPct: o.creatorAllocationPct,
        leftover,
        leftoverPct: (leftover / o.supply) * 100,
        burnedPct: (toB(residual.burned) / o.supply) * 100,
        graduationQuote,
        avgPrice,
        avgBuyerMultiple: avgPrice > 0 ? endPrice / avgPrice : 0,
        maxMultiple: endPrice / startPrice,
        openingImpactPct,
        refTrade,
        graduatedImpactPct,
        fee: { startBps, endBps, decaySec: o.feeDecaySec },
        segments: config.curve.filter((c) => !c.liquidity.isZero()).length,
    }
}
