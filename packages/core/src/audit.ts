import BN from 'bn.js'
import Decimal from 'decimal.js'
import { PoolConfig } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { Network, quoteAssetByMint } from './constants'
import { Finding } from './lint'
import { initialBaseSupply } from './sim/pool'

export const AUDIT_POLICY = 'launchproof/config-review@1'

export interface ConfigAudit {
    policy: typeof AUDIT_POLICY
    quoteMint: string
    quoteSymbol: string | null
    quoteDecimals: number | null
    raiseRaw: string
    raise: string | null
    migration: 'DAMM v1' | 'DAMM v2' | 'unknown'
    feeMode: number
    openingFeeBps: number
    timeFeeDecay: boolean | null
    dynamicFee: boolean
    unlockedLiquidityPct: number
    partnerUnlockedLiquidityPct: number
    creatorUnlockedLiquidityPct: number
    permanentlyLockedLiquidityPct: number
    mintAuthorityRetained: boolean | null
    leftoverSupplyPct: number
    migrationFeePct: number
    segments: number
    priceMultiple: number
    findings: Finding[]
}

/** Configured residual supply after the protocol's migration burn, not the dynamic mint buffer. */
export function residualSupply(config: PoolConfig): { leftover: BN; burned: BN } {
    const v = config.lockedVestingConfig
    const allocated = config.swapBaseAmount.add(config.migrationBaseThreshold)
        .add(v.amountPerPeriod.mul(v.numberOfPeriod)).add(v.cliffUnlockAmount)
    const excess = BN.max(new BN(0), initialBaseSupply(config).sub(allocated))
    const burnCap = config.fixedTokenSupplyFlag === 1
        ? BN.max(new BN(0), config.preMigrationTokenSupply.sub(config.postMigrationTokenSupply))
        : excess
    const burned = BN.min(excess, burnCap)
    return { leftover: excess.sub(burned), burned }
}

/** Read-only checks on decoded fields. No price feed, simulation, identity inference, or security certification. */
export function auditConfig(config: PoolConfig, network: Network, mintDecimals?: number): ConfigAudit {
    const quote = quoteAssetByMint(network, config.quoteMint)
    const decimals = quote?.decimals ?? mintDecimals ?? null
    if (decimals !== null && (!Number.isInteger(decimals) || decimals < 0 || decimals > 255)) {
        throw new Error('Invalid quote mint decimals')
    }
    const bf = config.poolFees.baseFee
    const timeMode = bf.baseFeeMode === 0 || bf.baseFeeMode === 1
    const timeFeeDecay = timeMode ? bf.firstFactor > 0 && !bf.secondFactor.isZero() && !bf.thirdFactor.isZero() : null
    const supply = initialBaseSupply(config)
    const leftover = residualSupply(config).leftover
    const leftoverPct = supply.isZero() ? 0 : new Decimal(leftover.toString()).div(supply.toString()).mul(100).toNumber()
    const unlocked = config.partnerLiquidityPercentage + config.creatorLiquidityPercentage
    const authority = config.tokenUpdateAuthority
    const retainsMint = authority <= 4 ? authority === 3 || authority === 4 : null
    const findings: Finding[] = []
    if (unlocked > 50) findings.push({ id: 'unlocked-lp', severity: 'warning', title: `${unlocked}% of migrated LP is initially unlocked`, detail: 'The configured partner and creator shares can be withdrawn after migration. This describes permission, not an observed withdrawal.' })
    if (retainsMint) findings.push({ id: 'mint-authority', severity: 'warning', title: 'Mint authority is retained', detail: 'The config permits additional issuance. This may be intentional for redeemable or externally backed assets.' })
    if (leftoverPct > 5) findings.push({ id: 'leftover-supply', severity: leftoverPct > 50 ? 'critical' : 'warning', title: `${leftoverPct.toFixed(1)}% configured residual supply`, detail: 'Estimated share of initial supply left for the leftover receiver after curve sales, migration allocation, vesting, and the configured burn. Real pool balances and fees can differ.' })
    if (config.migrationFeePercentage > 10) findings.push({ id: 'migration-fee', severity: 'warning', title: `${config.migrationFeePercentage}% migration fee`, detail: 'This share of the migration threshold is allocated as a fee before liquidity is deposited.' })
    if (timeFeeDecay === false) findings.push({ id: 'no-time-decay', severity: 'info', title: 'No time-decaying base fee', detail: 'This config has no active time decay. This alone does not establish sniping risk or the absence of other protections.' })
    if (!quote) findings.push({ id: 'custom-quote', severity: 'info', title: 'Custom quote mint', detail: 'Amounts are in this mint, never assumed to be SOL or USD. The mint address identifies the asset; no market value is inferred.' })
    if (timeFeeDecay === null) findings.push({ id: 'other-fee-mode', severity: 'info', title: 'Non-time-based fee mode', detail: 'Rate-limiter and market-cap fee schedules are not classified as time decay by this report.' })
    return {
        policy: AUDIT_POLICY, quoteMint: config.quoteMint.toBase58(), quoteSymbol: quote?.symbol ?? null,
        quoteDecimals: decimals, raiseRaw: config.migrationQuoteThreshold.toString(),
        raise: decimals === null ? null : new Decimal(config.migrationQuoteThreshold.toString()).div(new Decimal(10).pow(decimals)).toFixed(),
        migration: config.migrationOption === 0 ? 'DAMM v1' : config.migrationOption === 1 ? 'DAMM v2' : 'unknown',
        feeMode: bf.baseFeeMode, openingFeeBps: bf.cliffFeeNumerator.toNumber() / 1e5,
        timeFeeDecay, dynamicFee: config.poolFees.dynamicFee.initialized === 1,
        unlockedLiquidityPct: unlocked,
        partnerUnlockedLiquidityPct: config.partnerLiquidityPercentage,
        creatorUnlockedLiquidityPct: config.creatorLiquidityPercentage,
        permanentlyLockedLiquidityPct: config.partnerPermanentLockedLiquidityPercentage + config.creatorPermanentLockedLiquidityPercentage,
        mintAuthorityRetained: retainsMint, leftoverSupplyPct: leftoverPct,
        migrationFeePct: config.migrationFeePercentage,
        segments: config.curve.filter((c) => !c.liquidity.isZero()).length,
        priceMultiple: new Decimal(config.migrationSqrtPrice.toString()).div(config.sqrtStartPrice.toString()).pow(2).toNumber(),
        findings,
    }
}
