/**
 * Agent-based launch scenarios.
 *
 * A scenario is a cast of trading agents (snipers, a crowd, a whale, a panic) whose trade
 * sizes are expressed as fractions of the preset's graduation raise. That makes one
 * scenario portable across presets with very different raises and quote assets, so two
 * presets can be compared under identical market behaviour.
 *
 * Everything is driven by a seeded PRNG: the same preset + scenario + seed always produces
 * the same trades, which is what makes a simulation reviewable and shareable.
 */
import BN from 'bn.js'
import Decimal from 'decimal.js'
import {
    getBaseFeeHandler,
    getPriceFromSqrtPrice,
    getVariableFeeNumerator,
    PoolConfig,
    TradeDirection,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { SimPool, SimTrade, SLOT_SECONDS } from './pool'
import { expSample, lognormal, mulberry32 } from './rng'
import { MigrationOutcome, predictMigration } from './migration'

export type Cohort = 'creator' | 'sniper' | 'organic' | 'whale'

export type AgentSpec =
    /** The creator's first buy, bundled with pool creation at t = 0. */
    | { kind: 'creator'; buyFraction: number }
    /** Bots that buy inside the first seconds and sell after a holding period. */
    | { kind: 'snipers'; count: number; buyFraction: number; windowSec: number; holdSec: number; sellPct: number }
    /** A Poisson crowd of buyers and sellers with log-normal trade sizes. */
    | {
          kind: 'organic'
          buysPerMin: number
          medianBuyFraction: number
          spread: number
          sellChance: number
          sellPct: number
          fromSec: number
          toSec: number
          /** Optional decay of arrival rate (hype fades). */
          halfLifeSec?: number
      }
    | { kind: 'whale'; atSec: number; buyFraction: number }
    /** Every non-creator holder sells this share of their bag at once. */
    | { kind: 'panic'; atSec: number; sellPct: number }

export interface Scenario {
    id: string
    name: string
    description: string
    horizonSec: number
    seed: number
    agents: AgentSpec[]
}

export interface Actor {
    id: number
    cohort: Cohort
    holdings: BN
    /** Quote spent, fees included. */
    spent: BN
    /** Quote received from sells, after fees. */
    received: BN
    /** Fees paid, valued in quote at the trade price. */
    feesQuote: number
    trades: number
}

export interface TradeRecord extends SimTrade {
    actor: number
    cohort: Cohort
    /** Effective total fee rate paid on this trade, in bps. */
    feeBps: number
    priceAfter: number
}

export interface TimelinePoint {
    t: number
    price: number
    mcap: number
    progress: number
    baseFeeBps: number
    dynamicFeeBps: number
}

export interface CohortStats {
    cohort: Cohort
    actors: number
    trades: number
    spentQuote: number
    receivedQuote: number
    feesQuote: number
    /** Unrealised value at the graduation price (or final price if not graduated). */
    holdingsValueQuote: number
    pnlQuote: number
    roiPct: number
}

export interface ScenarioResult {
    scenario: Scenario
    trades: TradeRecord[]
    timeline: TimelinePoint[]
    graduated: boolean
    graduationSec: number | null
    volumeQuote: number
    fees: { protocol: number; partner: number; creator: number; referral: number; total: number }
    cohorts: CohortStats[]
    finalPrice: number
    migration: MigrationOutcome | null
}

interface Event {
    t: number
    order: number
    run: () => void
}

export interface RunOptions {
    totalSupply: number
    quoteDecimals: number
    /** Unix start time; fixed by default so results are reproducible. */
    startTime?: number
}

export function runScenario(config: PoolConfig, scenario: Scenario, opts: RunOptions): ScenarioResult {
    const startTime = opts.startTime ?? 1_760_000_000
    const pool = new SimPool(config, { startTime })
    const rng = mulberry32(scenario.seed)
    const baseDec = config.tokenDecimal
    const qScale = new Decimal(10).pow(opts.quoteDecimals)
    const toQuote = (x: BN) => new Decimal(x.toString()).div(qScale).toNumber()
    const priceOf = (sp: BN) => getPriceFromSqrtPrice(sp, baseDec, opts.quoteDecimals).toNumber()
    const threshold = config.migrationQuoteThreshold
    const raise = toQuote(threshold)
    const fromFraction = (f: number) =>
        new BN(new Decimal(threshold.toString()).mul(Math.max(0, f)).floor().toFixed())

    const actors: Actor[] = []
    const newActor = (cohort: Cohort): Actor => {
        const a: Actor = { id: actors.length, cohort, holdings: new BN(0), spent: new BN(0), received: new BN(0), feesQuote: 0, trades: 0 }
        actors.push(a)
        return a
    }

    const trades: TradeRecord[] = []
    const timeline: TimelinePoint[] = []
    const baseFee = getBaseFeeHandler(
        config.poolFees.baseFee.cliffFeeNumerator,
        config.poolFees.baseFee.firstFactor,
        config.poolFees.baseFee.secondFactor,
        config.poolFees.baseFee.thirdFactor,
        config.poolFees.baseFee.baseFeeMode
    )
    const feeAt = (t: number) => {
        const cur = pool.currentPoint(t)
        const base = baseFee.getBaseFeeNumeratorFromIncludedFeeAmount(
            cur,
            pool.state.activationPoint,
            TradeDirection.QuoteToBase,
            new BN(0)
        )
        const dyn = getVariableFeeNumerator(config.poolFees.dynamicFee, pool.state.volatilityTracker)
        return { baseFeeBps: base.toNumber() / 1e5, dynamicFeeBps: dyn.toNumber() / 1e5 }
    }
    const snapshot = (t: number) => {
        const price = priceOf(pool.state.sqrtPrice)
        timeline.push({
            t: t - startTime,
            price,
            mcap: price * opts.totalSupply,
            progress: Math.min(1, toQuote(pool.state.quoteReserve) / raise),
            ...feeAt(t),
        })
    }
    snapshot(startTime)

    const execute = (actor: Actor, side: 'buy' | 'sell', amountIn: BN, t: number, bundled = false) => {
        if (pool.isComplete() || amountIn.isZero()) return
        if (side === 'sell' && actor.holdings.isZero()) return
        let trade: SimTrade
        try {
            trade = pool.swap(
                { side, amountIn, mode: side === 'buy' ? 'partial-fill' : 'exact-in', bundledWithCreate: bundled },
                t
            )
        } catch {
            return // e.g. a sell larger than the curve can absorb; agents simply skip
        }
        const priceAfter = priceOf(trade.sqrtPriceAfter)
        const feeRaw = trade.tradingFee.add(trade.protocolFee).add(trade.referralFee)
        const feeQuote = trade.feeInBase
            ? new Decimal(feeRaw.toString()).div(new Decimal(10).pow(baseDec)).mul(priceAfter).toNumber()
            : toQuote(feeRaw)
        let notionalQuote: number
        if (side === 'buy') {
            actor.holdings = actor.holdings.add(trade.amountOut)
            actor.spent = actor.spent.add(trade.amountIn)
            notionalQuote = toQuote(trade.amountIn)
        } else {
            actor.holdings = actor.holdings.sub(trade.amountIn)
            actor.received = actor.received.add(trade.amountOut)
            notionalQuote = toQuote(trade.amountOut) + feeQuote
        }
        actor.feesQuote += feeQuote
        actor.trades++
        trades.push({
            ...trade,
            actor: actor.id,
            cohort: actor.cohort,
            feeBps: notionalQuote > 0 ? (feeQuote / notionalQuote) * 10_000 : 0,
            priceAfter,
        })
        snapshot(t)
    }

    // ---- schedule events -------------------------------------------------------------
    const events: Event[] = []
    let order = 0
    const at = (sec: number, run: () => void) => {
        if (sec <= scenario.horizonSec) events.push({ t: startTime + sec, order: order++, run })
    }

    for (const agent of scenario.agents) {
        switch (agent.kind) {
            case 'creator': {
                const a = newActor('creator')
                at(0, () => execute(a, 'buy', fromFraction(agent.buyFraction), startTime, true))
                break
            }
            case 'snipers': {
                for (let i = 0; i < agent.count; i++) {
                    const a = newActor('sniper')
                    const buyAt = rng() * agent.windowSec
                    at(buyAt, () => execute(a, 'buy', fromFraction(agent.buyFraction * (0.7 + rng() * 0.6)), startTime + buyAt))
                    const sellAt = buyAt + agent.holdSec * (0.8 + rng() * 0.4)
                    at(sellAt, () =>
                        execute(a, 'sell', a.holdings.muln(Math.round(agent.sellPct)).divn(100), startTime + sellAt)
                    )
                }
                break
            }
            case 'whale': {
                const a = newActor('whale')
                at(agent.atSec, () => execute(a, 'buy', fromFraction(agent.buyFraction), startTime + agent.atSec))
                break
            }
            case 'panic': {
                at(agent.atSec, () => {
                    for (const a of actors) {
                        if (a.cohort === 'creator') continue
                        execute(a, 'sell', a.holdings.muln(Math.round(agent.sellPct)).divn(100), startTime + agent.atSec)
                    }
                })
                break
            }
            case 'organic': {
                let t = agent.fromSec
                const baseRate = agent.buysPerMin / 60
                for (;;) {
                    const decay = agent.halfLifeSec ? Math.pow(0.5, (t - agent.fromSec) / agent.halfLifeSec) : 1
                    const rate = Math.max(1e-6, baseRate * decay)
                    t += expSample(rng, rate)
                    if (t > agent.toSec || t > scenario.horizonSec) break
                    const when = t
                    const sell = rng() < agent.sellChance
                    const size = lognormal(rng, agent.medianBuyFraction, agent.spread)
                    const pickR = rng()
                    at(when, () => {
                        if (sell) {
                            const holders = actors.filter((a) => a.cohort === 'organic' && !a.holdings.isZero())
                            if (holders.length === 0) return
                            const h = holders[Math.floor(pickR * holders.length)]
                            execute(h, 'sell', h.holdings.muln(Math.round(agent.sellPct)).divn(100), startTime + when)
                        } else {
                            execute(newActor('organic'), 'buy', fromFraction(size), startTime + when)
                        }
                    })
                }
                break
            }
        }
    }

    events.sort((a, b) => a.t - b.t || a.order - b.order)
    for (const e of events) {
        if (pool.isComplete()) break
        e.run()
    }

    // ---- results ----------------------------------------------------------------------
    const graduated = pool.isComplete()
    const finalPrice = graduated
        ? priceOf(config.migrationSqrtPrice)
        : priceOf(pool.state.sqrtPrice)
    const baseScale = new Decimal(10).pow(baseDec)
    const cohortNames: Cohort[] = ['creator', 'sniper', 'whale', 'organic']
    const cohorts: CohortStats[] = cohortNames
        .map((cohort) => {
            const as = actors.filter((a) => a.cohort === cohort)
            const spent = as.reduce((s, a) => s + toQuote(a.spent), 0)
            const received = as.reduce((s, a) => s + toQuote(a.received), 0)
            const holdingsValue = as.reduce(
                (s, a) => s + new Decimal(a.holdings.toString()).div(baseScale).toNumber() * finalPrice,
                0
            )
            const pnl = received + holdingsValue - spent
            return {
                cohort,
                actors: as.length,
                trades: as.reduce((s, a) => s + a.trades, 0),
                spentQuote: spent,
                receivedQuote: received,
                feesQuote: as.reduce((s, a) => s + a.feesQuote, 0),
                holdingsValueQuote: holdingsValue,
                pnlQuote: pnl,
                roiPct: spent > 0 ? (pnl / spent) * 100 : 0,
            }
        })
        .filter((c) => c.actors > 0)

    const st = pool.state
    const finalPriceForBase = finalPrice
    const baseFeeToQuote = (x: BN) => new Decimal(x.toString()).div(baseScale).toNumber() * finalPriceForBase
    const fees = {
        protocol: toQuote(st.protocolQuoteFee) + baseFeeToQuote(st.protocolBaseFee),
        partner: toQuote(st.partnerQuoteFee) + baseFeeToQuote(st.partnerBaseFee),
        creator: toQuote(st.creatorQuoteFee) + baseFeeToQuote(st.creatorBaseFee),
        referral: 0,
        total: 0,
    }
    fees.total = fees.protocol + fees.partner + fees.creator + fees.referral

    const volumeQuote = trades.reduce(
        (s, tr) => s + (tr.side === 'buy' ? toQuote(tr.amountIn) : toQuote(tr.amountOut)),
        0
    )

    return {
        scenario,
        trades,
        timeline,
        graduated,
        graduationSec: pool.finishTime !== null ? pool.finishTime - startTime : null,
        volumeQuote,
        fees,
        cohorts,
        finalPrice,
        migration: graduated ? predictMigration(config, pool.pool) : null,
    }
}

/** Base fee (bps) a trade would pay `seconds` after activation, from the config's scheduler. */
export function baseFeeBpsAt(config: PoolConfig, seconds: number): number {
    const handler = getBaseFeeHandler(
        config.poolFees.baseFee.cliffFeeNumerator,
        config.poolFees.baseFee.firstFactor,
        config.poolFees.baseFee.secondFactor,
        config.poolFees.baseFee.thirdFactor,
        config.poolFees.baseFee.baseFeeMode
    )
    const elapsed = Math.floor(config.activationType === 1 ? seconds : seconds / SLOT_SECONDS)
    const activation = new BN(1_000_000)
    return (
        handler
            .getBaseFeeNumeratorFromIncludedFeeAmount(
                activation.add(new BN(elapsed)),
                activation,
                TradeDirection.QuoteToBase,
                new BN(0)
            )
            .toNumber() / 1e5
    )
}

