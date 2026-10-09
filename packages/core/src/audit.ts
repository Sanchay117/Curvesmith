import BN from 'bn.js'
import Decimal from 'decimal.js'
import { AccountInfo, Connection, PublicKey } from '@solana/web3.js'
import { unpackMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { PoolConfig } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { Network, quoteAssetByMint } from './constants'
import { Finding } from './lint'
import { initialBaseSupply } from './sim/pool'

export const AUDIT_POLICY_V1 = 'launchproof/config-review@1'
export const AUDIT_POLICY = 'launchproof/config-review@2'

export async function readQuoteMintDecimals(connection: Connection, mint: PublicKey): Promise<number | undefined> {
    try {
        const account = await connection.getAccountInfo(mint)
        if (account && (account.owner.equals(TOKEN_PROGRAM_ID) || account.owner.equals(TOKEN_2022_PROGRAM_ID))) {
            return unpackMint(mint, account, account.owner).decimals
        }
    } catch { /* Keep unresolved amounts in raw units. */ }
    return undefined
}

export interface ConfigAuditV1 {
    policy: typeof AUDIT_POLICY_V1
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
    partnerUnlockedLiquidityPct?: number
    creatorUnlockedLiquidityPct?: number
    permanentlyLockedLiquidityPct: number
    mintAuthorityRetained: boolean | null
    leftoverSupplyPct: number
    migrationFeePct: number
    segments: number
    priceMultiple: number
    findings: Finding[]
}

export interface ConfigAudit extends Omit<ConfigAuditV1, 'policy' | 'partnerUnlockedLiquidityPct' | 'creatorUnlockedLiquidityPct'> {
    policy: typeof AUDIT_POLICY
    partnerUnlockedLiquidityPct: number
    creatorUnlockedLiquidityPct: number
    creatorTradingFeePct: number
    partnerTradingFeePct: number
    migrationFeeOption: number
    creatorMigrationFeePct: number
    partnerMigrationFeePct: number
    postMigrationPoolFeeBps: number | null
    partnerVesting: { percentage: number; periods: number; bpsPerPeriod: number; frequencySeconds: number; cliffSeconds: number }
    creatorVesting: { percentage: number; periods: number; bpsPerPeriod: number; frequencySeconds: number; cliffSeconds: number }
    tokenType: 'SPL Token' | 'Token-2022' | 'unknown'
    leftoverReceiver: string
    feeClaimer: string
    leftoverReceiverIsFeeClaimer: boolean
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
export function auditConfigV1(config: PoolConfig, network: Network, mintDecimals?: number): ConfigAuditV1 {
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
        policy: AUDIT_POLICY_V1, quoteMint: config.quoteMint.toBase58(), quoteSymbol: quote?.symbol ?? null,
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

/** Decode an observed token mint, never infer live authority from a config enum. */
export function readMintAuthority(mint: PublicKey, account: AccountInfo<Buffer>): string | null {
    if (!account.owner.equals(TOKEN_PROGRAM_ID) && !account.owner.equals(TOKEN_2022_PROGRAM_ID)) throw new Error('Invalid mint owner')
    return unpackMint(mint, account, account.owner).mintAuthority?.toBase58() ?? null
}

/** Preserve only the exact historical wording in existing policy-2 receipts. The predicate and severity are unchanged. */
export function preserveRecordedMintWording(reproduced: ConfigAudit | ConfigAuditV1, recorded: ConfigAudit | ConfigAuditV1): void {
    const old = recorded.findings.find((finding) => finding.id === 'mint-authority')
    const current = reproduced.findings.find((finding) => finding.id === 'mint-authority')
    if (current && old?.title === 'Mint authority is retained' && old.detail === 'The config permits additional issuance. This may be intentional for redeemable or externally backed assets.') {
        current.title = old.title
        current.detail = old.detail
    }
}

/** Policy 2 exposes payment destinations and migration terms, with explicit limits on interpretation. */
export function auditConfig(config: PoolConfig, network: Network, mintDecimals?: number): ConfigAudit {
    const previous = auditConfigV1(config, network, mintDecimals)
    const vesting = (info: PoolConfig['partnerLiquidityVestingInfo']) => ({
        percentage: info.isInitialized === 1 ? info.vestingPercentage : 0,
        periods: info.isInitialized === 1 ? info.numberOfPeriods : 0,
        bpsPerPeriod: info.isInitialized === 1 ? info.bpsPerPeriod : 0,
        frequencySeconds: info.isInitialized === 1 ? info.frequency : 0,
        cliffSeconds: info.isInitialized === 1 ? info.cliffDurationFromMigrationTime : 0,
    })
    const fixedPoolFees = [25, 30, 100, 200, 400, 600]
    const postMigrationPoolFeeBps = config.migrationOption !== 1 ? null
        : config.migrationFeeOption === 6 ? config.migratedPoolFeeBps : fixedPoolFees[config.migrationFeeOption] ?? null
    const sameReceiver = config.leftoverReceiver.equals(config.feeClaimer)
    const findings = previous.findings.map((finding) => finding.id === 'mint-authority' ? {
        ...finding,
        title: 'Config permits a retained mint authority (legacy mode)',
        detail: 'This legacy standard-config flag does not establish the live token mint authority. DBC 0.2.0 rejects these modes for new non-hook configs and pools. Inspect each existing base mint before claiming additional issuance is possible.',
    } : finding)
    if (previous.openingFeeBps >= 3000) findings.push({
        id: 'high-opening-fee', severity: 'warning', title: `${(previous.openingFeeBps / 100).toFixed(1)}% opening fee`,
        detail: previous.timeFeeDecay ? 'The configured opening fee is high, but the time scheduler decays it. Check the duration and settled rate before trading.' : 'The configured opening fee is high. This review found no active time decay; inspect the fee mode before trading.',
    })
    if (config.migrationOption === 0) findings.push({
        id: 'damm-v1-migration', severity: 'info', title: 'DAMM v1 migration',
        detail: 'This legacy migration path differs from DAMM v2. The DAMM v2 fee and LP behavior shown for other configs does not apply here.',
    })
    if (config.tokenType === 1) findings.push({
        id: 'token-2022', severity: 'info', title: 'Token-2022 base token',
        detail: 'The base token uses Token-2022. Review its mint extensions separately; this configuration review does not inspect the token mint.',
    })
    if (sameReceiver && previous.leftoverSupplyPct > 5) findings.push({
        id: 'same-leftover-fee-claimer', severity: 'info', title: 'Fee claimer also receives residual supply',
        detail: 'The same configured address receives partner fees and any residual base tokens after migration. This does not prove the address exercised either permission.',
    })
    return {
        ...previous, policy: AUDIT_POLICY,
        partnerUnlockedLiquidityPct: config.partnerLiquidityPercentage,
        creatorUnlockedLiquidityPct: config.creatorLiquidityPercentage,
        creatorTradingFeePct: config.creatorTradingFeePercentage,
        partnerTradingFeePct: 100 - config.creatorTradingFeePercentage,
        migrationFeeOption: config.migrationFeeOption,
        creatorMigrationFeePct: config.creatorMigrationFeePercentage,
        partnerMigrationFeePct: 100 - config.creatorMigrationFeePercentage,
        postMigrationPoolFeeBps,
        partnerVesting: vesting(config.partnerLiquidityVestingInfo),
        creatorVesting: vesting(config.creatorLiquidityVestingInfo),
        tokenType: config.tokenType === 0 ? 'SPL Token' : config.tokenType === 1 ? 'Token-2022' : 'unknown',
        leftoverReceiver: config.leftoverReceiver.toBase58(),
        feeClaimer: config.feeClaimer.toBase58(),
        leftoverReceiverIsFeeClaimer: sameReceiver,
        findings,
    }
}
