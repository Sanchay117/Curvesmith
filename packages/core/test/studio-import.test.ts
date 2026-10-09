import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { Connection, PublicKey } from '@solana/web3.js'
import { createDbcProgram, PoolConfig } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { compilePreset, defaultPreset, deriveConfigState, QUOTE_ASSETS, studioSpecFromConfig } from '../src'

const address = '38RRrtvAbAYnmCDjym31nvw5MYQGi3LQJQ6Gp6RbT7DU'
function config(quote: 'SOL' | 'USDC' = 'SOL') {
    const spec = defaultPreset()
    spec.quote = quote
    return deriveConfigState(compilePreset(spec).params, { quoteMint: QUOTE_ASSETS['mainnet-beta'][quote].mint, feeClaimer: PublicKey.default, leftoverReceiver: PublicKey.default })
}

describe('audit-to-Studio import', () => {
    for (const quote of ['SOL', 'USDC'] as const) test(`imports ${quote} terms into a compilable design`, () => {
        const source = config(quote)
        const imported = studioSpecFromConfig(source, 'mainnet-beta', address)
        expect(imported.spec.name).toBe('38RRrt...T7DU (improved)')
        expect(imported.spec.quote).toBe(quote)
        expect(imported.spec.fees.creatorSharePct).toBe(source.creatorTradingFeePercentage)
        expect(imported.spec.lp.creator.locked).toBe(source.creatorPermanentLockedLiquidityPercentage)
        expect(imported.notices.some((notice) => notice.includes('curve segments'))).toBe(true)
        expect(() => compilePreset(imported.spec)).not.toThrow()
    })
    test('rejects unsupported configs without substituting a default', () => {
        const source = config()
        source.quoteMint = PublicKey.default
        expect(() => studioSpecFromConfig(source, 'mainnet-beta', address)).toThrow('Unsupported quote')
        source.quoteMint = QUOTE_ASSETS['mainnet-beta'].SOL.mint
        source.migrationOption = 0
        expect(() => studioSpecFromConfig(source, 'mainnet-beta', address)).toThrow('DAMM v2')
        source.migrationOption = 1
        source.poolFees.baseFee.baseFeeMode = 2
        expect(() => studioSpecFromConfig(source, 'mainnet-beta', address)).toThrow('time-based')
    })
    test('resets legacy mint mode with an explicit notice', () => {
        const source = config()
        source.tokenUpdateAuthority = 3
        const imported = studioSpecFromConfig(source, 'mainnet-beta', address)
        expect(imported.spec.token.authority).toBe('immutable')
        expect(imported.notices.some((notice) => notice.includes('deprecated'))).toBe(true)
    })
    const { program } = createDbcProgram(new Connection('http://localhost:8899'))
    const fixtures = JSON.parse(readFileSync(new URL('./fixtures/mainnet-audit-golden.json', import.meta.url), 'utf8')) as Array<{ address: string; data: string }>
    for (const fixture of fixtures) test(`reconstructs mainnet ${fixture.address}`, () => {
        const source = program.coder.accounts.decode('poolConfig', Buffer.from(fixture.data, 'base64')) as PoolConfig
        const imported = studioSpecFromConfig(source, 'mainnet-beta', fixture.address)
        expect(imported.spec.token.leftover).toBeGreaterThanOrEqual(0)
        expect(() => compilePreset(imported.spec)).not.toThrow()
    })
})
