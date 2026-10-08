import { describe, expect, test } from 'vitest'
import { PublicKey } from '@solana/web3.js'
import BN from 'bn.js'
import { auditConfig, compilePreset, countPoolObservations, defaultPreset, deriveConfigState, QUOTE_ASSETS, readPoolCensusFields, residualSupply, specFromConfig } from '../src'

function config() {
    return deriveConfigState(compilePreset(defaultPreset()).params, {
        quoteMint: QUOTE_ASSETS['mainnet-beta'].SOL.mint, feeClaimer: PublicKey.default, leftoverReceiver: PublicKey.default,
    })
}

describe('configuration audit', () => {
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
