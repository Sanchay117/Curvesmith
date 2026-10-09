import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { Connection } from '@solana/web3.js'
import { createDbcProgram, PoolConfig } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { auditConfig, auditConfigV1, AuditReceipt, ConfigAuditV1, sha256, toHex, verifyAuditReceipt } from '../src'

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
    test('accepts exact historical mint wording but rejects altered wording', () => {
        const r = receipt()
        const fixture = JSON.parse(readFileSync(new URL('./fixtures/legacy-mint-config.json', import.meta.url), 'utf8'))
        const bytes = Buffer.from(fixture.data, 'base64')
        const config = program.coder.accounts.decode('poolConfig', bytes) as PoolConfig
        r.address = fixture.address
        r.configData = bytes.toString('base64')
        r.configHash = toHex(sha256(bytes))
        r.audit = auditConfig(config, 'devnet')
        const finding = r.audit.findings.find((finding) => finding.id === 'mint-authority')!
        finding.title = 'Mint authority is retained'
        finding.detail = 'The config permits additional issuance. This may be intentional for redeemable or externally backed assets.'
        expect(verifyAuditReceipt(r)).toEqual(r.audit)
        finding.detail = 'Definitely safe'
        expect(() => verifyAuditReceipt(r)).toThrow('do not reproduce')
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
        const config = program.coder.accounts.decode('poolConfig', Buffer.from(r.configData, 'base64')) as PoolConfig
        const legacyAudit: ConfigAuditV1 = auditConfigV1(config, 'devnet')
        delete legacyAudit.partnerUnlockedLiquidityPct
        delete legacyAudit.creatorUnlockedLiquidityPct
        const legacy = { ...r, audit: legacyAudit }
        expect(verifyAuditReceipt(legacy)).toEqual(legacy.audit)
    })
})
