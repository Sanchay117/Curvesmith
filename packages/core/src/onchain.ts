/**
 * Derives the on-chain `PoolConfig` account the DBC program would write for a given
 * `ConfigParameters`, without touching the chain.
 *
 * This mirrors `process_create_config` + `PoolConfig::init` in the DBC program. It lets the
 * simulator run on a design that has not been published yet. `test/differential.test.ts` checks
 * every field against the account the real program writes inside LiteSVM.
 */
import BN from 'bn.js'
import { PublicKey } from '@solana/web3.js'
import {
    ConfigParameters,
    getBaseTokenForSwap,
    getMigrationBaseToken,
    getMigrationThresholdPrice,
    MigratedCollectFeeMode,
    MigrationOption,
    PoolConfig,
} from '@meteora-ag/dynamic-bonding-curve-sdk'

const MAX_CURVE_POINT_CONFIG = 20
const ZERO = () => new BN(0)

export interface ConfigAccounts {
    quoteMint: PublicKey
    feeClaimer: PublicKey
    leftoverReceiver: PublicKey
}

/** `PoolConfig::get_migration_quote_amount`: quote that seeds DAMM v2, rounded up like the program. */
export function migrationQuoteAmount(threshold: BN, feePct: number): BN {
    const num = threshold.muln(100 - feePct)
    const { div, mod } = num.divmod(new BN(100))
    return mod.isZero() ? div : div.addn(1)
}

/** Borsh layout of MigratedPoolMarketCapFeeSchedulerParams: u16, u16, u32, u64 (little endian). */
function encodeMarketCapScheduler(p: ConfigParameters['migratedPoolMarketCapFeeSchedulerParams']): number[] {
    const buf = new Uint8Array(16)
    const view = new DataView(buf.buffer)
    view.setUint16(0, p.numberOfPeriod, true)
    view.setUint16(2, p.sqrtPriceStepBps, true)
    view.setUint32(4, p.schedulerExpirationDuration, true)
    buf.set(new BN(p.reductionFactor.toString()).toArray('le', 8), 8)
    return Array.from(buf)
}

export function deriveConfigState(params: ConfigParameters, accounts: ConfigAccounts): PoolConfig {
    const migrationSqrtPrice = getMigrationThresholdPrice(
        params.migrationQuoteThreshold,
        params.sqrtStartPrice,
        params.curve
    )
    const swapBaseAmount = getBaseTokenForSwap(params.sqrtStartPrice, migrationSqrtPrice, params.curve)
    const quoteAmount = migrationQuoteAmount(params.migrationQuoteThreshold, params.migrationFee.feePercentage)
    const compounding = params.migratedPoolFee.collectFeeMode === MigratedCollectFeeMode.Compounding
    const migrationBaseThreshold = getMigrationBaseToken(
        quoteAmount,
        migrationSqrtPrice,
        compounding ? MigrationOption.MET_DAMM : MigrationOption.MET_DAMM_V2
    )

    const dyn = params.poolFees.dynamicFee
    const vestingInfo = (v: ConfigParameters['partnerLiquidityVestingInfo']) => {
        const zero =
            v.vestingPercentage === 0 &&
            v.bpsPerPeriod === 0 &&
            v.numberOfPeriods === 0 &&
            v.frequency === 0 &&
            v.cliffDurationFromMigrationTime === 0
        return {
            isInitialized: zero ? 0 : 1,
            vestingPercentage: v.vestingPercentage,
            padding: [0, 0],
            bpsPerPeriod: v.bpsPerPeriod,
            numberOfPeriods: v.numberOfPeriods,
            frequency: v.frequency,
            cliffDurationFromMigrationTime: v.cliffDurationFromMigrationTime,
        }
    }

    const curve = Array.from({ length: MAX_CURVE_POINT_CONFIG }, (_, i) =>
        params.curve[i]
            ? { sqrtPrice: params.curve[i].sqrtPrice, liquidity: params.curve[i].liquidity }
            : { sqrtPrice: ZERO(), liquidity: ZERO() }
    )

    const config = {
        quoteMint: accounts.quoteMint,
        feeClaimer: accounts.feeClaimer,
        leftoverReceiver: accounts.leftoverReceiver,
        poolFees: {
            baseFee: {
                cliffFeeNumerator: params.poolFees.baseFee.cliffFeeNumerator,
                secondFactor: params.poolFees.baseFee.secondFactor,
                thirdFactor: params.poolFees.baseFee.thirdFactor,
                firstFactor: params.poolFees.baseFee.firstFactor,
                baseFeeMode: params.poolFees.baseFee.baseFeeMode,
                padding0: [0, 0, 0, 0, 0],
            },
            dynamicFee: dyn
                ? {
                      initialized: 1,
                      padding: [0, 0, 0, 0, 0, 0, 0],
                      maxVolatilityAccumulator: dyn.maxVolatilityAccumulator,
                      variableFeeControl: dyn.variableFeeControl,
                      binStep: dyn.binStep,
                      filterPeriod: dyn.filterPeriod,
                      decayPeriod: dyn.decayPeriod,
                      reductionFactor: dyn.reductionFactor,
                      padding2: [0, 0, 0, 0, 0, 0, 0, 0],
                      binStepU128: dyn.binStepU128,
                  }
                : {
                      initialized: 0,
                      padding: [0, 0, 0, 0, 0, 0, 0],
                      maxVolatilityAccumulator: 0,
                      variableFeeControl: 0,
                      binStep: 0,
                      filterPeriod: 0,
                      decayPeriod: 0,
                      reductionFactor: 0,
                      padding2: [0, 0, 0, 0, 0, 0, 0, 0],
                      binStepU128: ZERO(),
                  },
        },
        partnerLiquidityVestingInfo: vestingInfo(params.partnerLiquidityVestingInfo),
        creatorLiquidityVestingInfo: vestingInfo(params.creatorLiquidityVestingInfo),
        padding0: new Array(14).fill(0),
        padding1: 0,
        collectFeeMode: params.collectFeeMode,
        migrationOption: params.migrationOption,
        activationType: params.activationType,
        tokenDecimal: params.tokenDecimal,
        version: 0,
        tokenType: params.tokenType,
        quoteTokenFlag: 0,
        partnerPermanentLockedLiquidityPercentage: params.partnerPermanentLockedLiquidityPercentage,
        partnerLiquidityPercentage: params.partnerLiquidityPercentage,
        creatorPermanentLockedLiquidityPercentage: params.creatorPermanentLockedLiquidityPercentage,
        creatorLiquidityPercentage: params.creatorLiquidityPercentage,
        migrationFeeOption: params.migrationFeeOption,
        fixedTokenSupplyFlag: params.tokenSupply ? 1 : 0,
        creatorTradingFeePercentage: params.creatorTradingFeePercentage,
        tokenUpdateAuthority: params.tokenUpdateAuthority,
        migrationFeePercentage: params.migrationFee.feePercentage,
        creatorMigrationFeePercentage: params.migrationFee.creatorFeePercentage,
        padding2: new Array(7).fill(0),
        swapBaseAmount,
        migrationQuoteThreshold: params.migrationQuoteThreshold,
        migrationBaseThreshold,
        migrationSqrtPrice,
        lockedVestingConfig: {
            amountPerPeriod: params.lockedVesting.amountPerPeriod,
            cliffDurationFromMigrationTime: params.lockedVesting.cliffDurationFromMigrationTime,
            frequency: params.lockedVesting.frequency,
            numberOfPeriod: params.lockedVesting.numberOfPeriod,
            cliffUnlockAmount: params.lockedVesting.cliffUnlockAmount,
            padding: ZERO(),
        },
        preMigrationTokenSupply: params.tokenSupply?.preMigrationTokenSupply ?? ZERO(),
        postMigrationTokenSupply: params.tokenSupply?.postMigrationTokenSupply ?? ZERO(),
        migratedCollectFeeMode: params.migratedPoolFee.collectFeeMode,
        migratedDynamicFee: params.migratedPoolFee.dynamicFee,
        migratedPoolFeeBps: params.migratedPoolFee.poolFeeBps,
        migratedPoolBaseFeeMode: params.migratedPoolBaseFeeMode,
        enableFirstSwapWithMinFee: params.enableFirstSwapWithMinFee ? 1 : 0,
        migratedCompoundingFeeBps: params.compoundingFeeBps ?? 0,
        poolCreationFee: params.poolCreationFee,
        migratedPoolBaseFeeBytes: encodeMarketCapScheduler(params.migratedPoolMarketCapFeeSchedulerParams),
        sqrtStartPrice: params.sqrtStartPrice,
        curve,
    }
    return config as unknown as PoolConfig
}
