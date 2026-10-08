/**
 * SimPool: a stateful, in-memory DBC virtual pool.
 *
 * The *quote* math (how much comes out of a swap, which fee applies) is delegated to the
 * official SDK, which mirrors the program's fixed-point arithmetic. What the SDK does not
 * provide is the *state transition*: after a swap the program updates reserves, fee buckets
 * and the dynamic-fee volatility tracker. That part is ported here from
 * `VirtualPool::apply_swap_result`, `update_pre_swap` and `update_post_swap`.
 *
 * Result: a sequence of swaps on a SimPool lands on the same sqrt price, reserves and fees
 * as the same sequence on chain (verified in test/differential.test.ts against the real
 * program running in LiteSVM).
 */
import BN from 'bn.js'
import { PublicKey } from '@solana/web3.js'
import {
    getFeeMode,
    getSwapAmountWithBuffer,
    getSwapResultFromExactInput,
    getSwapResultFromPartialInput,
    PoolConfig,
    SwapResult2,
    TradeDirection,
    VirtualPool,
} from '@meteora-ag/dynamic-bonding-curve-sdk'

const PublicKeyDefault = PublicKey.default
const ONE_Q64 = new BN(1).shln(64)
const BASIS_POINT_MAX = new BN(10_000)
/** DBC slots are ~400ms; used when a preset activates by slot instead of timestamp. */
export const SLOT_SECONDS = 0.4

export type Side = 'buy' | 'sell'

export interface SwapIntent {
    side: Side
    /** Raw input amount: quote lamports for buys, base units for sells. */
    amountIn: BN
    /** Partial fill lets a buy stop at the graduation price instead of failing. */
    mode?: 'exact-in' | 'partial-fill'
    hasReferral?: boolean
    /** True only for a creator buy bundled with pool creation (when the preset enables it). */
    bundledWithCreate?: boolean
}

export interface SimTrade {
    t: number
    side: Side
    /** Amount actually pulled from the trader (fee-inclusive). */
    amountIn: BN
    amountOut: BN
    tradingFee: BN
    protocolFee: BN
    referralFee: BN
    partnerFee: BN
    creatorFee: BN
    /** Whether fees were charged in base tokens (sell side with OutputToken mode). */
    feeInBase: boolean
    sqrtPriceBefore: BN
    sqrtPriceAfter: BN
    completedCurve: boolean
}

function deltaBinId(binStepU128: BN, a: BN, b: BN): BN {
    const [upper, lower] = a.gt(b) ? [a, b] : [b, a]
    const ratio = upper.shln(64).div(lower)
    return ratio.sub(ONE_Q64).div(binStepU128).muln(2)
}

export interface SimPoolOptions {
    /** Unix seconds at pool creation (= activation for timestamp presets). */
    startTime: number
    /** Slot at pool creation, for slot-activated presets. */
    startSlot?: number
}

export class SimPool {
    readonly config: PoolConfig
    readonly startTime: number
    readonly startSlot: number
    readonly pool: VirtualPool
    finishTime: number | null = null

    constructor(config: PoolConfig, opts: SimPoolOptions) {
        this.config = config
        this.startTime = opts.startTime
        this.startSlot = opts.startSlot ?? 300_000_000
        const activationPoint =
            config.activationType === 1 ? new BN(opts.startTime) : new BN(this.startSlot)
        // Shape matches the decoded on-chain account so SDK quote functions accept it directly.
        this.pool = {
            poolState: {
                volatilityTracker: {
                    lastUpdateTimestamp: new BN(0),
                    padding: [0, 0, 0, 0, 0, 0, 0, 0],
                    sqrtPriceReference: new BN(0),
                    volatilityAccumulator: new BN(0),
                    volatilityReference: new BN(0),
                },
                config: PublicKeyDefault,
                creator: PublicKeyDefault,
                baseMint: PublicKeyDefault,
                baseVault: PublicKeyDefault,
                quoteVault: PublicKeyDefault,
                baseReserve: initialBaseSupply(config),
                quoteReserve: new BN(0),
                protocolBaseFee: new BN(0),
                protocolQuoteFee: new BN(0),
                partnerBaseFee: new BN(0),
                partnerQuoteFee: new BN(0),
                sqrtPrice: config.sqrtStartPrice,
                activationPoint,
                poolType: 0,
                isMigrated: 0,
                isPartnerWithdrawSurplus: 0,
                isProtocolWithdrawSurplus: 0,
                migrationProgress: 0,
                isWithdrawLeftover: 0,
                isCreatorWithdrawSurplus: 0,
                migrationFeeWithdrawStatus: 0,
                metrics: {
                    totalProtocolBaseFee: new BN(0),
                    totalProtocolQuoteFee: new BN(0),
                    totalTradingBaseFee: new BN(0),
                    totalTradingQuoteFee: new BN(0),
                },
                finishCurveTimestamp: new BN(0),
                creatorBaseFee: new BN(0),
                creatorQuoteFee: new BN(0),
                legacyCreationFeeBits: 0,
                creationFeeBits: 0,
                hasSwap: 0,
                padding0: [0, 0, 0, 0, 0],
                protocolLiquidityMigrationFeeBps: 20,
                padding1: [0, 0, 0, 0, 0, 0],
                protocolMigrationBaseFeeAmount: new BN(0),
                protocolMigrationQuoteFeeAmount: new BN(0),
                padding2: [new BN(0), new BN(0), new BN(0)],
            },
        } as unknown as VirtualPool
    }

    get state() {
        return this.pool.poolState
    }

    isComplete(): boolean {
        return this.state.quoteReserve.gte(this.config.migrationQuoteThreshold)
    }

    /** The program's "current point": unix seconds or slot, depending on activation type. */
    currentPoint(t: number): BN {
        if (this.config.activationType === 1) return new BN(Math.floor(t))
        return new BN(this.startSlot + Math.floor((t - this.startTime) / SLOT_SECONDS))
    }

    private dynamicEnabled(): boolean {
        return this.config.poolFees.dynamicFee.initialized !== 0
    }

    private updatePreSwap(now: number) {
        if (!this.dynamicEnabled()) return
        const dyn = this.config.poolFees.dynamicFee
        const vt = this.state.volatilityTracker
        const nowBn = new BN(now)
        const elapsed = nowBn.gt(vt.lastUpdateTimestamp) ? nowBn.sub(vt.lastUpdateTimestamp) : new BN(0)
        if (elapsed.gten(dyn.filterPeriod)) {
            vt.sqrtPriceReference = this.state.sqrtPrice
            if (elapsed.ltn(dyn.decayPeriod)) {
                vt.volatilityReference = vt.volatilityAccumulator.muln(dyn.reductionFactor).div(BASIS_POINT_MAX)
            } else {
                vt.volatilityReference = new BN(0)
            }
        }
    }

    private updatePostSwap(oldSqrtPrice: BN, now: number) {
        if (!this.dynamicEnabled()) return
        const dyn = this.config.poolFees.dynamicFee
        const vt = this.state.volatilityTracker
        const delta = deltaBinId(dyn.binStepU128, this.state.sqrtPrice, vt.sqrtPriceReference)
        const acc = vt.volatilityReference.add(delta.mul(BASIS_POINT_MAX))
        const max = new BN(dyn.maxVolatilityAccumulator)
        vt.volatilityAccumulator = BN.min(acc, max)
        if (deltaBinId(dyn.binStepU128, oldSqrtPrice, this.state.sqrtPrice).gtn(0)) {
            vt.lastUpdateTimestamp = new BN(now)
        }
    }

    private eligibleForMinFee(intent: SwapIntent): boolean {
        return (
            this.config.enableFirstSwapWithMinFee === 1 &&
            this.state.hasSwap === 0 &&
            !!intent.bundledWithCreate &&
            !intent.hasReferral
        )
    }

    /** Pure quote at time t: no state change. Applies the pre-swap volatility update on a copy. */
    quote(intent: SwapIntent, t: number): SwapResult2 {
        const snapshot = cloneTracker(this.state.volatilityTracker)
        try {
            this.updatePreSwap(Math.floor(t))
            return this.compute(intent, t)
        } finally {
            this.state.volatilityTracker = snapshot
        }
    }

    private compute(intent: SwapIntent, t: number): SwapResult2 {
        const direction = intent.side === 'buy' ? TradeDirection.QuoteToBase : TradeDirection.BaseToQuote
        const feeMode = getFeeMode(this.config.collectFeeMode, direction, !!intent.hasReferral)
        const fn = intent.mode === 'exact-in' ? getSwapResultFromExactInput : getSwapResultFromPartialInput
        return fn(
            this.pool,
            this.config,
            intent.amountIn,
            feeMode,
            direction,
            this.currentPoint(t),
            this.eligibleForMinFee(intent)
        )
    }

    /** Executes a swap at unix time t, mutating pool state exactly as the program would. */
    swap(intent: SwapIntent, t: number): SimTrade {
        if (this.isComplete()) throw new Error('PoolIsCompleted')
        if (intent.amountIn.isZero()) throw new Error('AmountIsZero')
        const now = Math.floor(t)
        this.updatePreSwap(now)
        const direction = intent.side === 'buy' ? TradeDirection.QuoteToBase : TradeDirection.BaseToQuote
        const feeMode = getFeeMode(this.config.collectFeeMode, direction, !!intent.hasReferral)
        const r = this.compute(intent, t)

        const s = this.state
        const before = s.sqrtPrice
        s.sqrtPrice = r.nextSqrtPrice

        // split_partner_and_creator_fee
        const creatorFee =
            this.config.creatorTradingFeePercentage === 0
                ? new BN(0)
                : r.tradingFee.muln(this.config.creatorTradingFeePercentage).divn(100)
        const partnerFee = r.tradingFee.sub(creatorFee)
        if (feeMode.feesOnBaseToken) {
            s.partnerBaseFee = s.partnerBaseFee.add(partnerFee)
            s.protocolBaseFee = s.protocolBaseFee.add(r.protocolFee)
            s.creatorBaseFee = s.creatorBaseFee.add(creatorFee)
            s.metrics.totalProtocolBaseFee = s.metrics.totalProtocolBaseFee.add(r.protocolFee)
            s.metrics.totalTradingBaseFee = s.metrics.totalTradingBaseFee.add(r.tradingFee)
        } else {
            s.partnerQuoteFee = s.partnerQuoteFee.add(partnerFee)
            s.protocolQuoteFee = s.protocolQuoteFee.add(r.protocolFee)
            s.creatorQuoteFee = s.creatorQuoteFee.add(creatorFee)
            s.metrics.totalProtocolQuoteFee = s.metrics.totalProtocolQuoteFee.add(r.protocolFee)
            s.metrics.totalTradingQuoteFee = s.metrics.totalTradingQuoteFee.add(r.tradingFee)
        }

        const actualOut = feeMode.feesOnInput
            ? r.outputAmount
            : r.outputAmount.add(r.tradingFee).add(r.protocolFee).add(r.referralFee)
        if (direction === TradeDirection.BaseToQuote) {
            s.baseReserve = s.baseReserve.add(r.excludedFeeInputAmount)
            s.quoteReserve = s.quoteReserve.sub(actualOut)
        } else {
            s.quoteReserve = s.quoteReserve.add(r.excludedFeeInputAmount)
            s.baseReserve = s.baseReserve.sub(actualOut)
        }

        this.updatePostSwap(before, now)
        s.hasSwap = 1

        const completed = this.isComplete()
        if (completed) {
            this.finishTime = now
            s.finishCurveTimestamp = new BN(now)
        }

        return {
            t,
            side: intent.side,
            amountIn: r.includedFeeInputAmount,
            amountOut: r.outputAmount,
            tradingFee: r.tradingFee,
            protocolFee: r.protocolFee,
            referralFee: r.referralFee,
            partnerFee,
            creatorFee,
            feeInBase: feeMode.feesOnBaseToken,
            sqrtPriceBefore: before,
            sqrtPriceAfter: s.sqrtPrice,
            completedCurve: completed,
        }
    }
}

function cloneTracker(vt: VirtualPool['poolState']['volatilityTracker']) {
    return {
        lastUpdateTimestamp: vt.lastUpdateTimestamp.clone(),
        padding: [...vt.padding],
        sqrtPriceReference: vt.sqrtPriceReference.clone(),
        volatilityAccumulator: vt.volatilityAccumulator.clone(),
        volatilityReference: vt.volatilityReference.clone(),
    }
}

/**
 * `PoolConfig::get_initial_base_supply`: the tokens minted into the pool at launch.
 * Launchproof presets compile to fixed supply; the dynamic branch serves other launchpads'
 * configs (swap amount plus a 25% buffer capped at the curve's capacity, plus graduation
 * liquidity and vesting).
 */
export function initialBaseSupply(config: PoolConfig): BN {
    if (config.fixedTokenSupplyFlag === 1) return config.preMigrationTokenSupply
    const curve = config.curve.filter((c) => !c.liquidity.isZero())
    const lv = config.lockedVestingConfig
    const vesting = lv.amountPerPeriod.mul(lv.numberOfPeriod).add(lv.cliffUnlockAmount)
    return getSwapAmountWithBuffer(config.swapBaseAmount, config.sqrtStartPrice, curve)
        .add(config.migrationBaseThreshold)
        .add(vesting)
}
