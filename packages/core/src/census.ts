import { PublicKey } from '@solana/web3.js'
import { ConfigAudit } from './audit'

// Includes the 8-byte account discriminator. Verified against real program accounts in lifecycle.test.ts.
export const POOL_CONFIG_OFFSET = 72
export const POOL_MIGRATED_OFFSET = 305
export const VIRTUAL_POOL_DISCRIMINATOR = 'cmrfVvtHrjd'

export function readPoolCensusFields(data: Uint8Array): { config: string; migrated: boolean } {
    if (data.length <= POOL_MIGRATED_OFFSET) throw new Error('Truncated pool account')
    const flag = data[POOL_MIGRATED_OFFSET]
    if (flag !== 0 && flag !== 1) throw new Error(`Unexpected migration flag ${flag}`)
    return { config: new PublicKey(data.subarray(POOL_CONFIG_OFFSET, POOL_CONFIG_OFFSET + 32)).toBase58(), migrated: flag === 1 }
}

export interface MintAuthorityObservation {
    samplePool: string
    baseMint: string | null
    status: 'set' | 'revoked' | 'unavailable'
    mintAuthority: string | null
    poolSlot: number
    mintSlot?: number
    observedAt: string
    error?: string
}

export interface CensusRow {
    address: string
    pools: number
    migrated: number
    samplePool: string
    audit?: ConfigAudit
    error?: string
    configHash?: string
    mintObservation?: MintAuthorityObservation
}

export interface CensusReport {
    schema: 'launchproof/census@1'
    generatedAt: string
    observedAt: string
    network: 'mainnet-beta' | 'devnet'
    programId: string
    sdkVersion: string
    source: string
    commitment: 'finalized'
    slots: number[]
    scope: string
    pools: number
    migrated: number
    configs: number
    duplicateObservations: number
    auditedConfigs: number
    auditedPools: number
    failures: number
    validation: { checked: number; mismatches: number }
    mintAuthorities?: {
        top: { flaggedConfigs: number; set: number; revoked: number; unavailable: number }
        tail: { flaggedConfigs: number; set: number; revoked: number; unavailable: number }
    }
    operators?: {
        matchedConfigs: number
        matchedPools: number
        distinctFeeClaimers: number
        top: Array<{ feeClaimer: string; configs: number; pools: number }>
    }
    tail?: {
        populationConfigs: number
        populationPools: number
        sampleSize: number
        evaluated: number
        failures: number
        seed: string
        findings: Array<{ id: string; count: number; share: number; low95: number; high95: number }>
    }
    evidence: Array<{ file: string; sha256: string }>
    rows: CensusRow[]
}

/** Deduplicate pools that migrate between the two finalized scans. Latest observation wins. */
export function countPoolObservations(observations: Iterable<{ pool: string; config: string; migrated: boolean }>): {
    rows: CensusRow[]; duplicates: number
} {
    const pools = new Map<string, { config: string; migrated: boolean }>()
    let duplicates = 0
    for (const o of observations) {
        if (pools.has(o.pool)) duplicates++
        pools.set(o.pool, { config: o.config, migrated: o.migrated })
    }
    const configs = new Map<string, CensusRow>()
    for (const [pool, o] of pools) {
        const row = configs.get(o.config) ?? { address: o.config, pools: 0, migrated: 0, samplePool: pool }
        row.pools++
        if (o.migrated) row.migrated++
        configs.set(o.config, row)
    }
    return { rows: [...configs.values()].sort((a, b) => b.pools - a.pools || a.address.localeCompare(b.address)), duplicates }
}
