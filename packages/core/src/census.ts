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

export interface CensusObservation {
    file: string
    slot: number
    fetchedAt: string
    timeSource: 'recorded-fetch' | 'cache-mtime'
}

export interface CensusPhase {
    firstObservedAt: string
    lastObservedAt: string
    minSlot: number
    maxSlot: number
    requests: number
    estimatedTimes: boolean
}

/** Collection times belong to RPC phases, not to a single atomic snapshot. */
export function censusPhases(observations: CensusObservation[]): Record<string, CensusPhase> {
    const phases: Record<string, CensusPhase> = {}
    const files = new Set<string>()
    for (const observation of observations) {
        const { file, slot, fetchedAt } = observation
        if (files.has(file)) throw new Error('Duplicate phase evidence')
        files.add(file)
        if (!Number.isSafeInteger(slot) || slot < 0 || !Number.isFinite(Date.parse(fetchedAt))) throw new Error('Invalid phase metadata')
        const phase = file.startsWith('pool-scan-') ? 'poolScan'
            : file === 'config-operators.json.gz' ? 'operators'
                : file.startsWith('validation-') ? 'decodeValidation'
                    : file.startsWith('tail-') ? 'tailReads'
                        : file.startsWith('authority-') ? 'mintAuthorities'
                            : /^(configs|mints)-/.test(file) ? 'topReads' : null
        if (!phase) throw new Error(`Unknown census phase: ${file}`)
        const current = phases[phase] ?? { firstObservedAt: fetchedAt, lastObservedAt: fetchedAt, minSlot: slot, maxSlot: slot, requests: 0, estimatedTimes: false }
        if (Date.parse(fetchedAt) < Date.parse(current.firstObservedAt)) current.firstObservedAt = fetchedAt
        if (Date.parse(fetchedAt) > Date.parse(current.lastObservedAt)) current.lastObservedAt = fetchedAt
        current.minSlot = Math.min(current.minSlot, slot)
        current.maxSlot = Math.max(current.maxSlot, slot)
        if (!['recorded-fetch', 'cache-mtime'].includes(observation.timeSource)) throw new Error('Invalid phase time source')
        current.estimatedTimes ||= observation.timeSource === 'cache-mtime'
        current.requests++
        phases[phase] = current
    }
    return phases
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
    phases?: Record<string, CensusPhase>
    scope: string
    pools: number
    migrated: number
    configs: number
    duplicateObservations: number
    auditedConfigs: number
    auditedPools: number
    failures: number
    validation: { checked: number; abortOnMismatch?: true; mismatches?: number }
    residualReceivers?: { thresholdPct: number; pools: number; sameFeeClaimerPools: number; sameFeeClaimerShare: number }
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
