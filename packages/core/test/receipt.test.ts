import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { Connection } from '@solana/web3.js'
import { createDbcProgram, PoolConfig } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { auditConfig, AuditReceipt, ConfigAudit, sha256, toHex, verifyAuditReceipt } from '../src'

const snapshot = JSON.parse(readFileSync(new URL('../../../apps/web/public/registry-devnet.json', import.meta.url), 'utf8'))
const { program } = createDbcProgram(new Connection('http://localhost:8899'))
function receipt(): AuditReceipt {
    const listing = snapshot.listings[0]
    const data = Buffer.from(listing.data, 'base64')
    const config = program.coder.accounts.decode('poolConfig', data) as PoolConfig
    return {
        schema: 'launchproof/audit-receipt@1', address: listing.config, network: 'devnet', slot: 1,
        fetchedAt: '2026-10-08T00:00:00.000Z', configData: listing.data, configHash: toHex(sha256(data)),
        audit: auditConfig(config, 'devnet'),
    }
}

describe('offline receipt verification', () => {
    test('reproduces a review from real config bytes without a network', () => {
        const r = receipt()
        expect(verifyAuditReceipt(JSON.parse(JSON.stringify(r)))).toEqual(r.audit)
    })
    test('rejects tampered account bytes', () => {
        const r = receipt()
        r.configData = Buffer.alloc(1048).toString('base64')
        expect(() => verifyAuditReceipt(r)).toThrow('hash')
    })
    test('rejects changed audit findings even with the original account hash', () => {
        const r = receipt()
        r.audit.unlockedLiquidityPct = 101
        expect(() => verifyAuditReceipt(r)).toThrow('do not reproduce')
    })
    test('accepts an earlier policy-1 receipt without the later LP split fields', () => {
        const r = receipt()
        const legacyAudit: Partial<ConfigAudit> = { ...r.audit }
        delete legacyAudit.partnerUnlockedLiquidityPct
        delete legacyAudit.creatorUnlockedLiquidityPct
        const legacy = { ...r, audit: legacyAudit as ConfigAudit }
        expect(verifyAuditReceipt(legacy)).toEqual(legacy.audit)
    })
})
