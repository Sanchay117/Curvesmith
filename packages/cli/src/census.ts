import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { Connection, PublicKey } from '@solana/web3.js'
import { unpackMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { createDbcProgram, PoolConfig, VirtualPool } from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
    readMintAuthority, preserveRecordedMintWording, MintAuthorityObservation,
    auditConfig, auditConfigV1, AUDIT_POLICY_V1, CensusReport, CensusRow, countPoolObservations, DBC_PROGRAM_ID,
    Network, POOL_CONFIG_OFFSET, POOL_MIGRATED_OFFSET, readPoolCensusFields, VIRTUAL_POOL_DISCRIMINATOR,
} from '@launchproof/core'

type RpcAccount = { owner: string; data: [string, 'base64']; executable: boolean; lamports: number }
type RpcResult<T> = { context: { slot: number }; value: T; fetchedAt: string }
type PoolRecord = { pubkey: string; account: RpcAccount }
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')
const require = createRequire(import.meta.url)
const sdkPackage = path.join(path.dirname(require.resolve('@meteora-ag/dynamic-bonding-curve-sdk')), '..', 'package.json')
const sdkVersion = (JSON.parse(fs.readFileSync(sdkPackage, 'utf8')) as { version: string }).version
const TAIL_SEED = 'launchproof-single-pool-v1'

function selectTail(rows: CensusRow[], size: number, seed: string): CensusRow[] {
    return rows.filter((row) => row.pools === 1)
        .map((row) => ({ row, rank: hash(Buffer.from(`${seed}:${row.address}`)) }))
        .sort((a, b) => a.rank.localeCompare(b.rank) || a.row.address.localeCompare(b.row.address))
        .slice(0, size).map(({ row }) => row)
}

function wilson(count: number, total: number): { low95: number; high95: number } {
    if (!total) return { low95: 0, high95: 1 }
    const z = 1.959963984540054
    const p = count / total
    const denominator = 1 + z * z / total
    const center = (p + z * z / (2 * total)) / denominator
    const margin = z * Math.sqrt(p * (1 - p) / total + z * z / (4 * total * total)) / denominator
    return { low95: Math.max(0, center - margin), high95: Math.min(1, center + margin) }
}

function tailFindings(rows: CensusRow[]) {
    const reviewed = rows.filter((row) => row.audit)
    const ids = [...new Set(reviewed.flatMap((row) => row.audit!.findings.map((finding) => finding.id)))].sort()
    return ids.map((id) => {
        const count = reviewed.filter((row) => row.audit!.findings.some((finding) => finding.id === id)).length
        return { id, count, share: count / reviewed.length, ...wilson(count, reviewed.length) }
    })
}

function summarizeOperators(rows: CensusRow[], records: PoolRecord[]): NonNullable<CensusReport['operators']> {
    const counts = new Map(rows.map((row) => [row.address, row]))
    const seen = new Set<string>()
    const operators = new Map<string, { configs: number; pools: number }>()
    let matchedConfigs = 0
    let matchedPools = 0
    for (const record of records) {
        if (seen.has(record.pubkey)) throw new Error(`Duplicate config account ${record.pubkey}`)
        seen.add(record.pubkey)
        const row = counts.get(record.pubkey)
        if (!row) continue
        if (record.account.owner !== DBC_PROGRAM_ID.toBase58()) throw new Error('Unexpected config owner')
        const bytes = Buffer.from(record.account.data[0], 'base64')
        if (bytes.length !== 64) throw new Error('Unexpected operator data slice length')
        const feeClaimer = new PublicKey(bytes.subarray(0, 32)).toBase58()
        const current = operators.get(feeClaimer) ?? { configs: 0, pools: 0 }
        current.configs++
        current.pools += row.pools
        operators.set(feeClaimer, current)
        matchedConfigs++
        matchedPools += row.pools
    }
    const top = [...operators].map(([feeClaimer, value]) => ({ feeClaimer, ...value }))
        .sort((a, b) => b.pools - a.pools || a.feeClaimer.localeCompare(b.feeClaimer)).slice(0, 12)
    return { matchedConfigs, matchedPools, distinctFeeClaimers: operators.size, top }
}

type MintEvidence = {
    config: string
    samplePool: string
    scope: 'top' | 'tail'
    pool: { account: RpcAccount | null; slot: number; fetchedAt: string }
    mint?: { address: string; account: RpcAccount | null; slot: number; fetchedAt: string }
}

function mintObservation(entry: MintEvidence, program: ReturnType<typeof createDbcProgram>['program']): MintAuthorityObservation {
    const observation: MintAuthorityObservation = {
        samplePool: entry.samplePool, baseMint: null, status: 'unavailable', mintAuthority: null,
        poolSlot: entry.pool.slot, observedAt: entry.mint?.fetchedAt ?? entry.pool.fetchedAt,
        ...(entry.mint ? { mintSlot: entry.mint.slot } : {}),
    }
    try {
        if (!Number.isSafeInteger(entry.pool.slot) || !Number.isFinite(Date.parse(entry.pool.fetchedAt)) || (entry.mint && (!Number.isSafeInteger(entry.mint.slot) || !Number.isFinite(Date.parse(entry.mint.fetchedAt))))) throw new Error('Invalid mint observation metadata')
        if (!entry.pool.account || entry.pool.account.owner !== DBC_PROGRAM_ID.toBase58()) throw new Error('Sample pool missing or invalid owner')
        const pool = program.coder.accounts.decode('virtualPool', Buffer.from(entry.pool.account.data[0], 'base64')) as VirtualPool
        if (pool.poolState.config.toBase58() !== entry.config) throw new Error('Sample pool config differs')
        observation.baseMint = pool.poolState.baseMint.toBase58()
        if (!entry.mint?.account) throw new Error('Base mint unavailable')
        if (entry.mint.address !== observation.baseMint) throw new Error('Sample base mint differs')
        const account = entry.mint.account
        observation.mintAuthority = readMintAuthority(pool.poolState.baseMint, {
            ...account, owner: new PublicKey(account.owner), data: Buffer.from(account.data[0], 'base64'),
        })
        observation.status = observation.mintAuthority === null ? 'revoked' : 'set'
    } catch (error) { observation.error = (error as Error).message }
    return observation
}

function residualReceivers(rows: CensusRow[]) {
    const residual = rows.filter((row) => row.audit && row.audit.leftoverSupplyPct > 5)
    const pools = residual.reduce((sum, row) => sum + row.pools, 0)
    const sameFeeClaimerPools = residual.filter((row) => row.audit!.leftoverReceiverIsFeeClaimer).reduce((sum, row) => sum + row.pools, 0)
    return { thresholdPct: 5, pools, sameFeeClaimerPools, sameFeeClaimerShare: pools ? sameFeeClaimerPools / pools : 0 }
}

function mintSummary(rows: CensusRow[]) {
    const flagged = rows.filter((row) => row.audit?.mintAuthorityRetained)
    return {
        flaggedConfigs: flagged.length,
        set: flagged.filter((row) => row.mintObservation?.status === 'set').length,
        revoked: flagged.filter((row) => row.mintObservation?.status === 'revoked').length,
        unavailable: flagged.filter((row) => !row.mintObservation || row.mintObservation.status === 'unavailable').length,
    }
}

export interface CensusOptions { out: string; cache: string; limit: number; tailSample: number; resume?: boolean; offline?: boolean }

export async function buildCensus(rpcUrl: string, network: Network, options: CensusOptions) {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 20_000) throw new Error('limit must be 1–20000')
    if (!Number.isInteger(options.tailSample) || options.tailSample < 1 || options.tailSample > 20_000) throw new Error('tail-sample must be 1–20000')
    const cache = path.resolve(options.cache)
    fs.mkdirSync(cache, { recursive: true })
    const identityPath = path.join(cache, 'identity.json')
    const source = new URL(rpcUrl).origin
    if (options.resume || options.offline) {
        const identity = JSON.parse(fs.readFileSync(identityPath, 'utf8'))
        if (identity.network !== network || identity.source !== source) throw new Error('Cache belongs to a different network or RPC source')
    } else {
        if (fs.existsSync(identityPath)) throw new Error('Cache already exists. Use --resume or choose a fresh --cache directory')
        fs.writeFileSync(identityPath, JSON.stringify({ network, source, startedAt: new Date().toISOString() }))
    }
    const evidence: CensusReport['evidence'] = []
    const slots: number[] = []
    const observationTimes: number[] = []
    async function request<T>(name: string, method: string, params: unknown[]): Promise<RpcResult<T>> {
        const file = path.join(cache, `${name}.json.gz`)
        let packed: Buffer
        if ((options.resume || options.offline) && fs.existsSync(file)) packed = fs.readFileSync(file)
        else {
            if (options.offline) throw new Error(`Missing offline evidence ${file}`)
            let result: { result?: RpcResult<T>; error?: { message: string } } | undefined
            for (let attempt = 0; attempt < 4; attempt++) {
                try {
                    const response = await fetch(rpcUrl, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ jsonrpc: '2.0', id: name, method, params }), signal: AbortSignal.timeout(300_000),
                    })
                    if (!response.ok) throw new Error(`RPC HTTP ${response.status}`)
                    result = await response.json() as typeof result
                    if (!result?.result || result.error) throw new Error(result?.error?.message ?? 'Missing RPC result')
                    break
                } catch (error) {
                    if (attempt === 3) throw error
                    console.error(`${name}: retry ${attempt + 1}: ${(error as Error).message}`)
                    await new Promise((resolve) => setTimeout(resolve, 2000 * 2 ** attempt))
                }
            }
            packed = gzipSync(JSON.stringify({ fetchedAt: new Date().toISOString(), request: { method, params }, result: result!.result }))
            fs.writeFileSync(`${file}.tmp`, packed)
            fs.renameSync(`${file}.tmp`, file)
        }
        evidence.push({ file: path.basename(file), sha256: hash(packed) })
        const saved = JSON.parse(gunzipSync(packed).toString())
        observationTimes.push(saved.fetchedAt ? Date.parse(saved.fetchedAt) : fs.statSync(file).mtimeMs)
        if (JSON.stringify(saved.request) !== JSON.stringify({ method, params })) throw new Error(`Cached request differs: ${name}`)
        const result = saved.result as RpcResult<T>
        if (!Number.isInteger(result.context?.slot) || !Array.isArray(result.value)) throw new Error(`Invalid RPC response: ${name}`)
        if (method === 'getMultipleAccounts' && result.value.length !== (params[0] as string[]).length) throw new Error(`Incomplete batch: ${name}`)
        result.fetchedAt = saved.fetchedAt
        slots.push(result.context.slot)
        return result
    }

    // Two scans keep responses smaller than fetching 424-byte accounts. No limit or pagination is applied.
    const observations: Array<{ pool: string; config: string; migrated: boolean }> = []
    const sampleKeys: string[] = []
    for (const migrated of [false, true]) {
        console.error(`Scanning ${migrated ? 'migrated' : 'unmigrated'} VirtualPool accounts…`)
        const scan = await request<PoolRecord[]>(`pool-scan-${Number(migrated)}`, 'getProgramAccounts', [DBC_PROGRAM_ID.toBase58(), {
            encoding: 'base64', commitment: 'finalized', withContext: true,
            dataSlice: { offset: POOL_CONFIG_OFFSET, length: 32 },
            filters: [{ memcmp: { offset: 0, bytes: VIRTUAL_POOL_DISCRIMINATOR } },
                { memcmp: { offset: POOL_MIGRATED_OFFSET, bytes: migrated ? '2' : '1' } }],
        }])
        if (scan.value.length === 0) throw new Error('Empty scan; refusing to publish a misleading census')
        for (const row of scan.value) {
            if (row.account.owner !== DBC_PROGRAM_ID.toBase58()) throw new Error('Unexpected account owner')
            const bytes = Buffer.from(row.account.data[0], 'base64')
            if (bytes.length !== 32) throw new Error('Unexpected data slice length')
            observations.push({ pool: row.pubkey, config: new PublicKey(bytes).toBase58(), migrated })
        }
        for (let i = 0; i < Math.min(100, scan.value.length); i++) sampleKeys.push(scan.value[Math.floor(i * scan.value.length / Math.min(100, scan.value.length))].pubkey)
        console.error(`${scan.value.length.toLocaleString()} accounts at slot ${scan.context.slot}`)
    }
    const { rows, duplicates } = countPoolObservations(observations)
    observations.length = 0
    const { program } = createDbcProgram(new Connection(rpcUrl))
    const poolCount = rows.reduce((n, r) => n + r.pools, 0)
    const migratedCount = rows.reduce((n, r) => n + r.migrated, 0)
    const top = rows.slice(0, options.limit)
    const singletons = rows.filter((row) => row.pools === 1)
    const tail = selectTail(rows, Math.min(options.tailSample, singletons.length), TAIL_SEED)
    fs.writeFileSync(path.join(cache, 'all-config-counts.json.gz'), gzipSync(JSON.stringify(rows)))
    const operatorScan = await request<PoolRecord[]>('config-operators', 'getProgramAccounts', [DBC_PROGRAM_ID.toBase58(), {
        encoding: 'base64', commitment: 'finalized', withContext: true,
        dataSlice: { offset: 40, length: 64 },
        filters: [{ memcmp: { offset: 0, bytes: '5RKzUGPpkkA' } }],
    }])
    if (!operatorScan.value.length) throw new Error('Empty config operator scan')
    const operators = summarizeOperators(rows, operatorScan.value)

    let checked = 0
    const samples: Array<{ address: string; data: string }> = []
    for (let i = 0; i < sampleKeys.length; i += 100) {
        const batch = await request<Array<RpcAccount | null>>(`validation-${i}`, 'getMultipleAccounts', [sampleKeys.slice(i, i + 100), { encoding: 'base64', commitment: 'finalized' }])
        for (let j = 0; j < batch.value.length; j++) {
            const account = batch.value[j]
            if (!account || account.owner !== DBC_PROGRAM_ID.toBase58()) throw new Error('Validation pool unavailable')
            const data = Buffer.from(account.data[0], 'base64')
            const decoded = program.coder.accounts.decode('virtualPool', data) as VirtualPool
            const fields = readPoolCensusFields(data)
            if (fields.config !== decoded.poolState.config.toBase58() || fields.migrated !== (decoded.poolState.isMigrated === 1)) throw new Error('Pool offset validation failed')
            checked++
            samples.push({ address: sampleKeys[i + j], data: account.data[0] })
        }
    }
    const decoded = new Map<string, PoolConfig>()
    const configs: Array<{ address: string; data: string; slot: number }> = []
    for (let i = 0; i < top.length; i += 100) {
        console.error(`Reading configs ${i + 1}–${Math.min(i + 100, top.length)} of ${top.length}…`)
        const batch = await request<Array<RpcAccount | null>>(`configs-${i}`, 'getMultipleAccounts', [top.slice(i, i + 100).map((r) => r.address), { encoding: 'base64', commitment: 'finalized' }])
        for (let j = 0; j < batch.value.length; j++) {
            const row = top[i + j]
            const account = batch.value[j]
            try {
                if (!account || account.owner !== DBC_PROGRAM_ID.toBase58()) throw new Error('Config missing or incorrect owner')
                const bytes = Buffer.from(account.data[0], 'base64')
                decoded.set(row.address, program.coder.accounts.decode('poolConfig', bytes) as PoolConfig)
                row.configHash = hash(bytes)
                configs.push({ address: row.address, data: account.data[0], slot: batch.context.slot })
            } catch (error) { row.error = (error as Error).message }
        }
    }
    const mints = [...new Set([...decoded.values()].map((c) => c.quoteMint.toBase58()))].sort()
    const decimals = new Map<string, number>()
    const mintEvidence: Array<{ address: string; data: string; owner: string }> = []
    for (let i = 0; i < mints.length; i += 100) {
        const batch = await request<Array<RpcAccount | null>>(`mints-${i}`, 'getMultipleAccounts', [mints.slice(i, i + 100), { encoding: 'base64', commitment: 'finalized' }])
        batch.value.forEach((account, j) => {
            if (!account) return
            const mint = mints[i + j]
            try {
                const owner = new PublicKey(account.owner)
                if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID)) return
                decimals.set(mint, unpackMint(new PublicKey(mint), { ...account, owner, data: Buffer.from(account.data[0], 'base64') }, owner).decimals)
                mintEvidence.push({ address: mint, data: account.data[0], owner: account.owner })
            } catch { /* Keep unresolved amounts in raw units. */ }
        })
    }
    for (const row of top) {
        const config = decoded.get(row.address)
        if (!config) continue
        try { row.audit = auditConfig(config, network, decimals.get(config.quoteMint.toBase58())) }
        catch (error) { row.error = (error as Error).message }
    }
    const tailEntries: Array<{ address: string; data?: string; slot?: number; error?: string }> = []
    const tailDecoded = new Map<string, PoolConfig>()
    for (let i = 0; i < tail.length; i += 100) {
        console.error(`Reading single-pool sample ${i + 1}–${Math.min(i + 100, tail.length)} of ${tail.length}…`)
        const batch = await request<Array<RpcAccount | null>>(`tail-configs-${i}`, 'getMultipleAccounts', [tail.slice(i, i + 100).map((r) => r.address), { encoding: 'base64', commitment: 'finalized' }])
        for (let j = 0; j < batch.value.length; j++) {
            const row = tail[i + j]
            const account = batch.value[j]
            try {
                if (!account || account.owner !== DBC_PROGRAM_ID.toBase58()) throw new Error('Config missing or incorrect owner')
                const config = program.coder.accounts.decode('poolConfig', Buffer.from(account.data[0], 'base64')) as PoolConfig
                tailDecoded.set(row.address, config)
                tailEntries.push({ address: row.address, data: account.data[0], slot: batch.context.slot })
            } catch (error) { tailEntries.push({ address: row.address, error: (error as Error).message }) }
        }
    }
    const tailMints = [...new Set([...tailDecoded.values()].map((c) => c.quoteMint.toBase58()))].filter((mint) => !decimals.has(mint)).sort()
    for (let i = 0; i < tailMints.length; i += 100) {
        const batch = await request<Array<RpcAccount | null>>(`tail-mints-${i}`, 'getMultipleAccounts', [tailMints.slice(i, i + 100), { encoding: 'base64', commitment: 'finalized' }])
        batch.value.forEach((account, j) => {
            if (!account) return
            const mint = tailMints[i + j]
            try {
                const owner = new PublicKey(account.owner)
                if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID)) return
                decimals.set(mint, unpackMint(new PublicKey(mint), { ...account, owner, data: Buffer.from(account.data[0], 'base64') }, owner).decimals)
                mintEvidence.push({ address: mint, data: account.data[0], owner: account.owner })
            } catch { /* Keep unresolved amounts in raw units. */ }
        })
    }
    for (const row of tail) {
        const config = tailDecoded.get(row.address)
        if (!config) continue
        try { row.audit = auditConfig(config, network, decimals.get(config.quoteMint.toBase58())) }
        catch (error) { tailEntries.find((entry) => entry.address === row.address)!.error = (error as Error).message }
    }
    const mintObservations: MintEvidence[] = []
    for (const scope of ['top', 'tail'] as const) {
        const flagged = (scope === 'top' ? top : tail).filter((row) => row.audit?.mintAuthorityRetained)
        for (let i = 0; i < flagged.length; i += 100) {
            const selected = flagged.slice(i, i + 100)
            const pools = await request<Array<RpcAccount | null>>(`authority-${scope}-pools-${i}`, 'getMultipleAccounts', [selected.map((row) => row.samplePool), { encoding: 'base64', commitment: 'finalized' }])
            const entries: MintEvidence[] = selected.map((row, j) => ({ config: row.address, samplePool: row.samplePool, scope, pool: { account: pools.value[j], slot: pools.context.slot, fetchedAt: pools.fetchedAt } }))
            const mintKeys = [...new Set(entries.map((entry) => mintObservation(entry, program).baseMint).filter((mint): mint is string => mint !== null))]
            if (mintKeys.length) {
                const accounts = await request<Array<RpcAccount | null>>(`authority-${scope}-mints-${i}`, 'getMultipleAccounts', [mintKeys, { encoding: 'base64', commitment: 'finalized' }])
                for (const entry of entries) {
                    const key = mintObservation(entry, program).baseMint
                    if (key) entry.mint = { address: key, account: accounts.value[mintKeys.indexOf(key)], slot: accounts.context.slot, fetchedAt: accounts.fetchedAt }
                }
            }
            entries.forEach((entry, j) => { selected[j].mintObservation = mintObservation(entry, program) })
            mintObservations.push(...entries)
        }
    }
    const tailReviewed = tail.filter((row) => row.audit)
    const audited = top.filter((r) => r.audit)
    const report: CensusReport = {
        schema: 'launchproof/census@1', generatedAt: new Date().toISOString(), observedAt: new Date(Math.max(...observationTimes)).toISOString(), network, programId: DBC_PROGRAM_ID.toBase58(),
        sdkVersion, source, commitment: 'finalized', slots, pools: poolCount, migrated: migratedCount, configs: rows.length,
        scope: 'Existing standard VirtualPool accounts observed across two finalized scans. Excludes transfer-hook pools and closed accounts. This is an observation window, not a historical launch count or a single-slot snapshot. Migration is a program flag, not evidence of users, demand, volume, or misconduct.',
        duplicateObservations: duplicates, auditedConfigs: audited.length, auditedPools: audited.reduce((n, r) => n + r.pools, 0),
        failures: top.length - audited.length, validation: { checked, mismatches: 0 }, evidence, rows: top,
        operators,
        residualReceivers: residualReceivers(top),
        mintAuthorities: { top: mintSummary(top), tail: mintSummary(tail) },
        tail: {
            populationConfigs: singletons.length, populationPools: singletons.length,
            sampleSize: tail.length, evaluated: tailReviewed.length, failures: tail.length - tailReviewed.length,
            seed: TAIL_SEED, findings: tailFindings(tail),
        },
    }
    fs.mkdirSync(path.dirname(options.out), { recursive: true })
    const publicEvidence = options.out.replace(/\.json$/, '') + '-evidence.json.gz'
    fs.writeFileSync(publicEvidence, gzipSync(JSON.stringify({ schema: 'launchproof/census-evidence@1', configs, samples, mints: mintEvidence, tail: tailEntries, mintObservations })))
    report.evidence.push({ file: path.basename(publicEvidence), sha256: hash(fs.readFileSync(publicEvidence)) })
    fs.writeFileSync(`${options.out}.tmp`, JSON.stringify(report))
    fs.renameSync(`${options.out}.tmp`, options.out)
    console.error(`Saved ${options.out}: ${poolCount.toLocaleString()} observed pools; ${audited.length} audited configs cover ${(100 * report.auditedPools / poolCount).toFixed(1)}%.`)
    return report
}

/** Verify the published selection; aggregate counts require replaying the complete local archive. */
export function verifyCensus(reportPath: string, cachePath?: string) {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as CensusReport
    if (report.schema !== 'launchproof/census@1') throw new Error('Unknown census schema')
    const evidenceFile = reportPath.replace(/\.json$/, '') + '-evidence.json.gz'
    const packed = fs.readFileSync(evidenceFile)
    const expected = report.evidence.find((e) => e.file === path.basename(evidenceFile))
    if (!expected || hash(packed) !== expected.sha256) throw new Error('Evidence archive hash mismatch')
    const evidence = JSON.parse(gunzipSync(packed).toString()) as {
        configs: Array<{ address: string; data: string }>; samples: Array<{ address: string; data: string }>;
        mints: Array<{ address: string; data: string; owner: string }>;
        mintObservations?: MintEvidence[];
        tail?: Array<{ address: string; data?: string; slot?: number; error?: string }>;
    }
    const { program } = createDbcProgram(new Connection('http://localhost:8899'))
    const mints = new Map(evidence.mints.map((m) => [m.address, m]))
    const configs = new Map(evidence.configs.map((c) => [c.address, c]))
    let verified = 0
    for (const row of report.rows) {
        if (!row.audit) continue
        const stored = configs.get(row.address)
        if (!stored) throw new Error(`Missing config evidence ${row.address}`)
        const bytes = Buffer.from(stored.data, 'base64')
        if (hash(bytes) !== row.configHash) throw new Error(`Config hash mismatch ${row.address}`)
        const config = program.coder.accounts.decode('poolConfig', bytes) as PoolConfig
        const mint = mints.get(config.quoteMint.toBase58())
        let precision: number | undefined
        if (mint) {
            const owner = new PublicKey(mint.owner)
            if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID)) throw new Error('Invalid mint owner')
            precision = unpackMint(config.quoteMint, { data: Buffer.from(mint.data, 'base64'), owner, lamports: 0, executable: false }, owner).decimals
        }
        const recordedPolicy: string = row.audit.policy
        const reproduced = recordedPolicy === AUDIT_POLICY_V1 ? auditConfigV1(config, report.network, precision) : auditConfig(config, report.network, precision)
        if (recordedPolicy === AUDIT_POLICY_V1 && !('partnerUnlockedLiquidityPct' in row.audit) && !('creatorUnlockedLiquidityPct' in row.audit)) {
            delete (reproduced as Partial<typeof reproduced>).partnerUnlockedLiquidityPct
            delete (reproduced as Partial<typeof reproduced>).creatorUnlockedLiquidityPct
        }
        preserveRecordedMintWording(reproduced, row.audit)
        if (JSON.stringify(reproduced) !== JSON.stringify(row.audit)) throw new Error(`Review mismatch ${row.address}`)
        verified++
    }
    for (const sample of evidence.samples) {
        const bytes = Buffer.from(sample.data, 'base64')
        const decoded = program.coder.accounts.decode('virtualPool', bytes) as VirtualPool
        const fields = readPoolCensusFields(bytes)
        if (fields.config !== decoded.poolState.config.toBase58() || fields.migrated !== (decoded.poolState.isMigrated === 1)) throw new Error('Sample decoding mismatch')
    }
    if (report.residualReceivers && JSON.stringify(residualReceivers(report.rows)) !== JSON.stringify(report.residualReceivers)) throw new Error('Residual receiver summary differs')
    const observed = evidence.mintObservations ?? []
    if (new Set(observed.map((entry) => `${entry.scope}:${entry.config}`)).size !== observed.length) throw new Error('Duplicate mint observation')
    function verifyMintRows(rows: CensusRow[], scope: 'top' | 'tail') {
        const flagged = rows.filter((row) => row.audit?.mintAuthorityRetained)
        if (observed.filter((entry) => entry.scope === scope).length !== flagged.length) throw new Error('Mint observation count differs')
        for (const row of flagged) {
            const entry = observed.find((entry) => entry.config === row.address && entry.scope === scope)
            if (!entry) throw new Error(`Missing mint evidence ${row.address}`)
            if (row.samplePool && row.samplePool !== entry.samplePool) throw new Error('Sample pool differs')
            const reproduced = mintObservation(entry, program)
            if (scope === 'top' && JSON.stringify(reproduced) !== JSON.stringify(row.mintObservation)) throw new Error('Mint observation differs')
            row.mintObservation = reproduced
        }
        if (JSON.stringify(mintSummary(rows)) !== JSON.stringify(report.mintAuthorities?.[scope])) throw new Error('Mint authority summary differs')
    }
    if (report.mintAuthorities) verifyMintRows(report.rows, 'top')
    if (report.tail) {
        if (!evidence.tail || evidence.tail.length !== report.tail.sampleSize) throw new Error('Tail sample evidence count differs')
        const addresses = evidence.tail.map((entry) => entry.address)
        if (new Set(addresses).size !== addresses.length) throw new Error('Duplicate tail sample address')
        if (cachePath) {
            const counts = JSON.parse(gunzipSync(fs.readFileSync(path.join(cachePath, 'all-config-counts.json.gz'))).toString()) as CensusRow[]
            if (counts.filter((row) => row.pools === 1).length !== report.tail.populationConfigs) throw new Error('Tail population count differs')
            const selection = selectTail(counts, report.tail.sampleSize, report.tail.seed).map((row) => row.address)
            if (JSON.stringify(selection) !== JSON.stringify(addresses)) throw new Error('Tail selection differs from complete count archive')
        }
        const reviews: CensusRow[] = []
        const tailPolicy: string | undefined = report.rows.find((row) => row.audit)?.audit?.policy
        for (const entry of evidence.tail) {
            if (!entry.data) continue
            const bytes = Buffer.from(entry.data, 'base64')
            const config = program.coder.accounts.decode('poolConfig', bytes) as PoolConfig
            const mint = mints.get(config.quoteMint.toBase58())
            let precision: number | undefined
            if (mint) {
                const owner = new PublicKey(mint.owner)
                if (!owner.equals(TOKEN_PROGRAM_ID) && !owner.equals(TOKEN_2022_PROGRAM_ID)) throw new Error('Invalid tail mint owner')
                precision = unpackMint(config.quoteMint, { data: Buffer.from(mint.data, 'base64'), owner, lamports: 0, executable: false }, owner).decimals
            }
            try {
                reviews.push({ address: entry.address, pools: 1, migrated: 0, samplePool: '', configHash: hash(bytes), audit: tailPolicy === AUDIT_POLICY_V1 ? auditConfigV1(config, report.network, precision) as unknown as CensusRow['audit'] : auditConfig(config, report.network, precision) })
            } catch {
                if (!entry.error) throw new Error(`Unexpected tail review failure ${entry.address}`)
            }
        }
        if (report.mintAuthorities) verifyMintRows(reviews, 'tail')
        if (reviews.length !== report.tail.evaluated || report.tail.failures !== report.tail.sampleSize - reviews.length) throw new Error('Tail review counts differ')
        if (JSON.stringify(tailFindings(reviews)) !== JSON.stringify(report.tail.findings)) throw new Error('Tail finding estimates differ')
    }
    if (report.operators && cachePath) {
        const counts = JSON.parse(gunzipSync(fs.readFileSync(path.join(cachePath, 'all-config-counts.json.gz'))).toString()) as CensusRow[]
        const file = path.join(cachePath, 'config-operators.json.gz')
        const packedScan = fs.readFileSync(file)
        const expectedScan = report.evidence.find((entry) => entry.file === path.basename(file))
        if (!expectedScan || hash(packedScan) !== expectedScan.sha256) throw new Error('Operator scan hash mismatch')
        const scan = JSON.parse(gunzipSync(packedScan).toString()) as { result: RpcResult<PoolRecord[]> }
        if (JSON.stringify(summarizeOperators(counts, scan.result.value)) !== JSON.stringify(report.operators)) throw new Error('Operator aggregates differ')
    }
    if (verified !== report.auditedConfigs || evidence.samples.length !== report.validation.checked) throw new Error('Verification counts differ')
    console.log(`Verified ${verified} top config reviews, ${report.tail?.evaluated ?? 0} sampled tail reviews, ${evidence.samples.length} pool layouts${report.operators && cachePath ? ', and fee-claimer aggregates' : ''}. Full-network totals require replaying the raw scan archive; chain inclusion is not proven.`)
}
