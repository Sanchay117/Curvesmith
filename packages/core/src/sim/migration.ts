/**
 * What happens at graduation, predicted from config + final pool state.
 *
 * Mirrors `handle_migrate_damm_v2`: the raise minus the graduation fee seeds a full-range
 * DAMM v2 pool at exactly the migration price, Meteora takes a 0.2% liquidity fee, and the
 * remaining LP is split between the preset author (partner) and the creator according to
 * the config's unlocked / permanently locked / vesting percentages.
 */
import BN from 'bn.js'
import { PoolConfig, VirtualPool } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { migrationQuoteAmount } from '../onchain'

const PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS = 20
const PARTNER_AND_CREATOR_SURPLUS_SHARE = 80

export interface LpShare {
    unlockedPct: number
    lockedPct: number
    vestingPct: number
}

export interface MigrationOutcome {
    /** Quote that seeds the DAMM v2 pool (after graduation fee and protocol liquidity fee). */
    quoteToPool: BN
    /** Base that seeds the DAMM v2 pool. */
    baseToPool: BN
    /** DAMM v2 opening sqrt price (Q64.64), equal to the curve's final price. */
    sqrtPrice: BN
    /** Graduation fee taken from the raise, and how it splits. */
    migrationFee: { total: BN; partner: BN; creator: BN }
    /** Quote that overshot the threshold on the final buy. */
    surplus: { total: BN; partner: BN; creator: BN; protocol: BN }
    /** Trading fees accrued on the curve and still claimable. */
    tradingFees: { partnerQuote: BN; creatorQuote: BN; partnerBase: BN; creatorBase: BN }
    lp: { partner: LpShare; creator: LpShare }
}

function bps(x: BN, b: number): BN {
    return x.muln(b).divn(10_000)
}

export function predictMigration(config: PoolConfig, pool: VirtualPool): MigrationOutcome {
    const s = pool.poolState
    const threshold = config.migrationQuoteThreshold
    const quoteAmount = migrationQuoteAmount(threshold, config.migrationFeePercentage)
    const fee = threshold.sub(quoteAmount)
    const creatorMigFee = fee.muln(config.creatorMigrationFeePercentage).divn(100)

    const surplusTotal = s.quoteReserve.gt(threshold) ? s.quoteReserve.sub(threshold) : new BN(0)
    const pcSurplus = surplusTotal.muln(PARTNER_AND_CREATOR_SURPLUS_SHARE).divn(100)
    const creatorSurplus =
        config.creatorTradingFeePercentage === 0
            ? new BN(0)
            : pcSurplus.muln(config.creatorTradingFeePercentage).divn(100)

    const quoteToPool = quoteAmount.sub(bps(quoteAmount, PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS))
    const baseToPool = config.migrationBaseThreshold.sub(
        bps(config.migrationBaseThreshold, PROTOCOL_LIQUIDITY_MIGRATION_FEE_BPS)
    )

    return {
        quoteToPool,
        baseToPool,
        sqrtPrice: config.migrationSqrtPrice,
        migrationFee: { total: fee, partner: fee.sub(creatorMigFee), creator: creatorMigFee },
        surplus: {
            total: surplusTotal,
            partner: pcSurplus.sub(creatorSurplus),
            creator: creatorSurplus,
            protocol: surplusTotal.sub(pcSurplus),
        },
        tradingFees: {
            partnerQuote: s.partnerQuoteFee,
            creatorQuote: s.creatorQuoteFee,
            partnerBase: s.partnerBaseFee,
            creatorBase: s.creatorBaseFee,
        },
        lp: {
            partner: {
                unlockedPct: config.partnerLiquidityPercentage,
                lockedPct: config.partnerPermanentLockedLiquidityPercentage,
                vestingPct: config.partnerLiquidityVestingInfo.vestingPercentage,
            },
            creator: {
                unlockedPct: config.creatorLiquidityPercentage,
                lockedPct: config.creatorPermanentLockedLiquidityPercentage,
                vestingPct: config.creatorLiquidityVestingInfo.vestingPercentage,
            },
        },
    }
}
