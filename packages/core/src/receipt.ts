import { Connection, PublicKey } from '@solana/web3.js'
import { createDbcProgram, PoolConfig } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { unpackMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { auditConfig, auditConfigV1, AUDIT_POLICY, AUDIT_POLICY_V1, ConfigAudit, ConfigAuditV1, preserveRecordedMintWording } from './audit'
import { Network } from './constants'
import { sha256, toHex } from './hash'

export interface AuditReceipt {
    schema: 'launchproof/audit-receipt@1'
    address: string
    network: Network
    slot: number
    fetchedAt: string
    configHash: string
    configData: string
    quoteMintAccount?: { data: string; owner: string }
    audit: ConfigAudit
}

export type LegacyAuditReceipt = Omit<AuditReceipt, 'audit'> & { audit: ConfigAuditV1 }

/** Reproduces the recorded checks offline. Does not verify chain inclusion or observation metadata. */
export function verifyAuditReceipt(receipt: AuditReceipt | LegacyAuditReceipt): ConfigAudit | ConfigAuditV1 {
    if (receipt.schema !== 'launchproof/audit-receipt@1') throw new Error('Unknown audit receipt schema')
    if (!['devnet', 'mainnet-beta'].includes(receipt.network)) throw new Error('Invalid receipt network')
    new PublicKey(receipt.address)
    if (!Number.isSafeInteger(receipt.slot) || receipt.slot < 0 || !Number.isFinite(Date.parse(receipt.fetchedAt))) throw new Error('Invalid observation metadata')
    const bytes = Buffer.from(receipt.configData, 'base64')
    if (toHex(sha256(bytes)) !== receipt.configHash) throw new Error('Config account hash does not match')
    const { program } = createDbcProgram(new Connection('http://localhost:8899'))
    const config = program.coder.accounts.decode('poolConfig', bytes) as PoolConfig
    let decimals: number | undefined
    if (receipt.quoteMintAccount) {
        const owner = new PublicKey(receipt.quoteMintAccount.owner)
        if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID)) throw new Error('Invalid quote mint owner')
        decimals = unpackMint(config.quoteMint, {
            data: Buffer.from(receipt.quoteMintAccount.data, 'base64'), owner, executable: false, lamports: 0,
        }, owner).decimals
    }
    if (receipt.audit.policy !== AUDIT_POLICY && receipt.audit.policy !== AUDIT_POLICY_V1) throw new Error('Unknown audit policy')
    const reproduced = receipt.audit.policy === AUDIT_POLICY_V1 ? auditConfigV1(config, receipt.network, decimals) : auditConfig(config, receipt.network, decimals)
    // Early @1 receipts preceded the partner/creator LP breakdown. Their other fields are unchanged.
    if (!('partnerUnlockedLiquidityPct' in receipt.audit) && !('creatorUnlockedLiquidityPct' in receipt.audit)) {
        delete (reproduced as Partial<ConfigAudit>).partnerUnlockedLiquidityPct
        delete (reproduced as Partial<ConfigAudit>).creatorUnlockedLiquidityPct
    }
    preserveRecordedMintWording(reproduced, receipt.audit)
    if (JSON.stringify(reproduced) !== JSON.stringify(receipt.audit)) throw new Error('Audit findings do not reproduce under the recorded policy')
    return reproduced
}
