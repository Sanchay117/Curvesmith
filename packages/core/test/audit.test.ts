import { describe, expect, test } from 'vitest'
import { readFileSync } from 'node:fs'
import { Connection, PublicKey } from '@solana/web3.js'
import { createDbcProgram, PoolConfig } from '@meteora-ag/dynamic-bonding-curve-sdk'
import BN from 'bn.js'
import { MintLayout, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from '@solana/spl-token'
import { analyzePreset, auditConfig, readMintAuthority, censusPhases, compilePreset, countPoolObservations, defaultPreset, deriveConfigState, lintPreset, QUOTE_ASSETS, readPoolCensusFields, residualSupply, specFromConfig } from '../src'

function config() {
    return deriveConfigState(compilePreset(defaultPreset()).params, {
        quoteMint: QUOTE_ASSETS['mainnet-beta'].SOL.mint, feeClaimer: PublicKey.default, leftoverReceiver: PublicKey.default,
    })
}

describe('configuration audit', () => {
    const has = (c: ReturnType<typeof config>, id: string) => auditConfig(c, 'mainnet-beta').findings.find((finding) => finding.id === id)
    function fixedResidual(leftover: number) {
        const c = config()
        c.fixedTokenSupplyFlag = 1
        c.preMigrationTokenSupply = new BN(10_000)
        c.postMigrationTokenSupply = new BN(10_000)
        c.swapBaseAmount = new BN(10_000 - leftover)
        c.migrationBaseThreshold = new BN(0)
        c.lockedVestingConfig.amountPerPeriod = new BN(0)
        c.lockedVestingConfig.cliffUnlockAmount = new BN(0)
        return c
    }
    test('flags majority unlocked LP only above 50%', () => {
        const c = config()
        c.partnerLiquidityPercentage = 50
        c.creatorLiquidityPercentage = 0
        expect(has(c, 'unlocked-lp')).toBeUndefined()
        c.creatorLiquidityPercentage = 1
        expect(has(c, 'unlocked-lp')?.severity).toBe('warning')
    })
    test('flags retained mint authority modes', () => {
        const c = config()
        c.tokenUpdateAuthority = 2
        expect(has(c, 'mint-authority')).toBeUndefined()
        c.tokenUpdateAuthority = 3
        expect(has(c, 'mint-authority')?.severity).toBe('warning')
        expect(has(c, 'mint-authority')?.title).toContain('legacy mode')
        expect(has(c, 'mint-authority')?.detail).toContain('does not establish')
        c.tokenUpdateAuthority = 4
        expect(has(c, 'mint-authority')?.title).toContain('legacy mode')
    })
    test('uses strict 5% and 50% residual supply thresholds', () => {
        expect(has(fixedResidual(500), 'leftover-supply')).toBeUndefined()
        expect(has(fixedResidual(501), 'leftover-supply')?.severity).toBe('warning')
        expect(has(fixedResidual(5000), 'leftover-supply')?.severity).toBe('warning')
        expect(has(fixedResidual(5001), 'leftover-supply')?.severity).toBe('critical')
    })
    test('flags migration fee only above 10%', () => {
        const c = config()
        c.migrationFeePercentage = 10
        expect(has(c, 'migration-fee')).toBeUndefined()
        c.migrationFeePercentage = 11
        expect(has(c, 'migration-fee')?.severity).toBe('warning')
    })
    test('distinguishes absent time decay from another fee mode', () => {
        const c = config()
        c.poolFees.baseFee.baseFeeMode = 0
        c.poolFees.baseFee.firstFactor = 0
        expect(has(c, 'no-time-decay')?.severity).toBe('info')
        c.poolFees.baseFee.baseFeeMode = 2
        expect(has(c, 'no-time-decay')).toBeUndefined()
        expect(has(c, 'other-fee-mode')?.severity).toBe('info')
    })
    test('Studio lint and on-chain review give no time decay the same severity', () => {
        const spec = defaultPreset()
        spec.fees.schedule.endBps = spec.fees.schedule.startBps
        const analyzed = analyzePreset(spec)
        const lint = lintPreset(analyzed)
        const audit = auditConfig(analyzed.config, 'mainnet-beta')
        expect(lint.findings.find((finding) => finding.id === 'no-time-decay')?.severity).toBe('info')
        expect(audit.findings.find((finding) => finding.id === 'no-time-decay')?.severity).toBe('info')
    })
    test('flags a 30% opening fee and says when it decays', () => {
        const c = config()
        c.poolFees.baseFee.cliffFeeNumerator = new BN(299_900_000)
        expect(has(c, 'high-opening-fee')).toBeUndefined()
        c.poolFees.baseFee.cliffFeeNumerator = new BN(300_000_000)
        expect(has(c, 'high-opening-fee')?.severity).toBe('warning')
        expect(has(c, 'high-opening-fee')?.detail).toContain('decays')
    })
    test('flags legacy DAMM v1 and Token-2022 explicitly', () => {
        const c = config()
        c.migrationOption = 0
        c.tokenType = 1
        expect(has(c, 'damm-v1-migration')?.severity).toBe('info')
        expect(has(c, 'token-2022')?.severity).toBe('info')
    })
    test('flags a fee claimer receiving more than 5% residual supply', () => {
        const c = fixedResidual(501)
        expect(has(c, 'same-leftover-fee-claimer')?.severity).toBe('info')
        c.leftoverReceiver = new PublicKey('11111111111111111111111111111112')
        expect(has(c, 'same-leftover-fee-claimer')).toBeUndefined()
    })
    test('reports fee splits, migrated pool fee, and LP vesting schedule', () => {
        const c = config()
        c.creatorTradingFeePercentage = 40
        c.creatorMigrationFeePercentage = 30
        c.migrationFeeOption = 1
        c.partnerLiquidityVestingInfo.isInitialized = 1
        c.partnerLiquidityVestingInfo.vestingPercentage = 20
        c.partnerLiquidityVestingInfo.frequency = 86_400
        const a = auditConfig(c, 'mainnet-beta')
        expect(a).toMatchObject({ creatorTradingFeePct: 40, partnerTradingFeePct: 60, creatorMigrationFeePct: 30, partnerMigrationFeePct: 70, postMigrationPoolFeeBps: 30 })
        expect(a.partnerVesting).toMatchObject({ percentage: 20, frequencySeconds: 86_400 })
        c.migrationFeeOption = 6
        c.migratedPoolFeeBps = 125
        expect(auditConfig(c, 'mainnet-beta').postMigrationPoolFeeBps).toBe(125)
    })
    test('never labels an unknown mint SOL, even when it has nine decimals', () => {
        const c = config()
        c.quoteMint = new PublicKey('11111111111111111111111111111112')
        const a = auditConfig(c, 'mainnet-beta', 9)
        expect(a.quoteSymbol).toBeNull()
        expect(a.quoteMint).toBe(c.quoteMint.toBase58())
        expect(a.raise).not.toBeNull()
        expect(auditConfig(c, 'mainnet-beta').raise).toBeNull()
        expect(() => specFromConfig(c, 'mainnet-beta')).toThrow('Unsupported quote mint')
    })
    test('decodes known assets using their actual precision', () => {
        const c = config()
        c.quoteMint = QUOTE_ASSETS['mainnet-beta'].USDC.mint
        c.migrationQuoteThreshold = new BN(85_000_000)
        expect(auditConfig(c, 'mainnet-beta')).toMatchObject({ quoteSymbol: 'USDC', quoteDecimals: 6, raise: '85' })
    })
    test('dynamic supply buffer is burned, not assigned to the leftover receiver', () => {
        const c = config()
        c.fixedTokenSupplyFlag = 0
        expect(residualSupply(c).leftover.isZero()).toBe(true)
        expect(auditConfig(c, 'mainnet-beta').leftoverSupplyPct).toBe(0)
    })
    test('subtracts the configured burn from fixed-supply residuals', () => {
        const c = config()
        const v = c.lockedVestingConfig
        const allocated = c.swapBaseAmount.add(c.migrationBaseThreshold).add(v.amountPerPeriod.mul(v.numberOfPeriod)).add(v.cliffUnlockAmount)
        c.preMigrationTokenSupply = allocated.addn(1000)
        c.postMigrationTokenSupply = allocated.addn(300)
        const r = residualSupply(c)
        expect(r.burned.toString()).toBe('700')
        expect(r.leftover.toString()).toBe('300')
    })
    test('keeps rate-limiter protection distinct from absent time decay', () => {
        const c = config()
        c.poolFees.baseFee.baseFeeMode = 2
        expect(auditConfig(c, 'mainnet-beta').timeFeeDecay).toBeNull()
        expect(auditConfig(c, 'mainnet-beta').findings.some((f) => f.id === 'no-time-decay')).toBe(false)
        expect(() => specFromConfig(c, 'mainnet-beta')).toThrow('time-based fees')
    })
    test('reports v1 migration without running the v2-only Studio model', () => {
        const c = config()
        c.migrationOption = 0
        expect(auditConfig(c, 'mainnet-beta').migration).toBe('DAMM v1')
        expect(() => specFromConfig(c, 'mainnet-beta')).toThrow('DAMM v2')
    })
})

describe('census accounting', () => {
    test('reads fee claimer and leftover receiver from the verified config slice', () => {
        const snapshot = JSON.parse(readFileSync(new URL('../../../apps/web/public/registry-devnet.json', import.meta.url), 'utf8'))
        const bytes = Buffer.from(snapshot.listings[0].data, 'base64')
        const { program } = createDbcProgram(new Connection('http://localhost:8899'))
        const decoded = program.coder.accounts.decode('poolConfig', bytes) as PoolConfig
        expect(new PublicKey(bytes.subarray(40, 72)).toBase58()).toBe(decoded.feeClaimer.toBase58())
        expect(new PublicKey(bytes.subarray(72, 104)).toBase58()).toBe(decoded.leftoverReceiver.toBase58())
    })
    test('counts migrating pools once and preserves the latest status', () => {
        const result = countPoolObservations([
            { pool: 'p1', config: 'a', migrated: false }, { pool: 'p2', config: 'a', migrated: false },
            { pool: 'p1', config: 'a', migrated: true }, { pool: 'p3', config: 'b', migrated: true },
        ])
        expect(result.duplicates).toBe(1)
        expect(result.rows.map(({ address, pools, migrated }) => ({ address, pools, migrated }))).toEqual([
            { address: 'a', pools: 2, migrated: 1 }, { address: 'b', pools: 1, migrated: 1 },
        ])
    })
    test('rejects truncated accounts and unknown migration flags', () => {
        expect(() => readPoolCensusFields(new Uint8Array(100))).toThrow('Truncated')
        const bytes = new Uint8Array(424)
        bytes[305] = 2
        expect(() => readPoolCensusFields(bytes)).toThrow('Unexpected migration flag')
    })
})

describe('observed mint authority', () => {
    test('distinguishes set and revoked authorities for both token programs', () => {
        const data = Buffer.alloc(MintLayout.span)
        const authority = new PublicKey('11111111111111111111111111111112')
        for (const owner of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
            for (const retained of [false, true]) {
                MintLayout.encode({ mintAuthorityOption: retained ? 1 : 0, mintAuthority: authority, supply: 1n, decimals: 6, isInitialized: true, freezeAuthorityOption: 0, freezeAuthority: PublicKey.default }, data)
                expect(readMintAuthority(PublicKey.default, { owner, data, lamports: 1, executable: false })).toBe(retained ? authority.toBase58() : null)
            }
        }
        expect(() => readMintAuthority(PublicKey.default, { owner: PublicKey.default, data, lamports: 1, executable: false })).toThrow('Invalid mint owner')
        expect(() => readMintAuthority(PublicKey.default, { owner: TOKEN_PROGRAM_ID, data: Buffer.alloc(0), lamports: 1, executable: false })).toThrow()
    })
})

describe('census collection windows', () => {
    test('keeps pool, tail and mint windows separate and rejects invalid metadata', () => {
        const observations = [
            { timeSource: 'cache-mtime' as const, file: 'pool-scan-0.json.gz', slot: 1, fetchedAt: '2026-10-08T00:00:00Z' },
            { timeSource: 'cache-mtime' as const, file: 'pool-scan-1.json.gz', slot: 2, fetchedAt: '2026-10-08T00:01:00Z' },
            { timeSource: 'recorded-fetch' as const, file: 'tail-configs-0.json.gz', slot: 10, fetchedAt: '2026-10-08T06:30:00Z' },
            { timeSource: 'recorded-fetch' as const, file: 'authority-top-mints-0.json.gz', slot: 20, fetchedAt: '2026-10-09T00:00:00Z' },
        ]
        const phases = censusPhases(observations)
        expect(phases.poolScan).toEqual({ firstObservedAt: observations[0].fetchedAt, lastObservedAt: observations[1].fetchedAt, minSlot: 1, maxSlot: 2, requests: 2, estimatedTimes: true })
        expect(phases.tailReads.firstObservedAt).toBe(observations[2].fetchedAt)
        expect(phases.mintAuthorities.minSlot).toBe(20)
        expect(() => censusPhases([...observations, observations[0]])).toThrow('Duplicate')
        expect(() => censusPhases([{ ...observations[0], fetchedAt: 'invalid' }])).toThrow('Invalid')
        expect(() => censusPhases([{ ...observations[0], slot: -1 }])).toThrow('Invalid')
    })
})
