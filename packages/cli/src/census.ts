import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync, gunzipSync } from 'node:zlib'
import { Connection, PublicKey } from '@solana/web3.js'
import { unpackMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { createDbcProgram, PoolConfig, VirtualPool } from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
    auditConfig, CensusReport, CensusRow, countPoolObservations, DBC_PROGRAM_ID,
    Network, POOL_CONFIG_OFFSET, POOL_MIGRATED_OFFSET, readPoolCensusFields, VIRTUAL_POOL_DISCRIMINATOR,
} from '@launchproof/core'

type RpcAccount = { owner: string; data: [string, 'base64']; executable: boolean; lamports: number }
type RpcResult<T> = { context: { slot: number }; value: T }
type PoolRecord = { pubkey: string; account: RpcAccount }
const hash = (data: Uint8Array) => createHash('sha256').update(data).digest('hex')

export interface CensusOptions { out: string; cache: string; limit: number; resume?: boolean; offline?: boolean }

export async function buildCensus(rpcUrl: string, network: Network, options: CensusOptions) {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 20_000) throw new Error('limit must be 1–20000')
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
    fs.writeFileSync(path.join(cache, 'all-config-counts.json.gz'), gzipSync(JSON.stringify(rows)))

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
    const audited = top.filter((r) => r.audit)
    const report: CensusReport = {
        schema: 'launchproof/census@1', generatedAt: new Date().toISOString(), observedAt: new Date(Math.max(...observationTimes)).toISOString(), network, programId: DBC_PROGRAM_ID.toBase58(),
        sdkVersion: '1.5.13', source, commitment: 'finalized', slots, pools: poolCount, migrated: migratedCount, configs: rows.length,
        scope: 'Existing standard VirtualPool accounts observed across two finalized scans. Excludes transfer-hook pools and closed accounts. This is an observation window, not a historical launch count or a single-slot snapshot. Migration is a program flag, not evidence of users, demand, volume, or misconduct.',
        duplicateObservations: duplicates, auditedConfigs: audited.length, auditedPools: audited.reduce((n, r) => n + r.pools, 0),
        failures: top.length - audited.length, validation: { checked, mismatches: 0 }, evidence, rows: top,
    }
    fs.mkdirSync(path.dirname(options.out), { recursive: true })
    const publicEvidence = options.out.replace(/\.json$/, '') + '-evidence.json.gz'
    fs.writeFileSync(publicEvidence, gzipSync(JSON.stringify({ schema: 'launchproof/census-evidence@1', configs, samples, mints: mintEvidence })))
    report.evidence.push({ file: path.basename(publicEvidence), sha256: hash(fs.readFileSync(publicEvidence)) })
    fs.writeFileSync(`${options.out}.tmp`, JSON.stringify(report))
    fs.renameSync(`${options.out}.tmp`, options.out)
    console.error(`Saved ${options.out}: ${poolCount.toLocaleString()} observed pools; ${audited.length} audited configs cover ${(100 * report.auditedPools / poolCount).toFixed(1)}%.`)
    return report
}

/** Verify the published selection; aggregate counts require replaying the complete local archive. */
export function verifyCensus(reportPath: string) {
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as CensusReport
    if (report.schema !== 'launchproof/census@1') throw new Error('Unknown census schema')
    const evidenceFile = reportPath.replace(/\.json$/, '') + '-evidence.json.gz'
    const packed = fs.readFileSync(evidenceFile)
    const expected = report.evidence.find((e) => e.file === path.basename(evidenceFile))
    if (!expected || hash(packed) !== expected.sha256) throw new Error('Evidence archive hash mismatch')
    const evidence = JSON.parse(gunzipSync(packed).toString()) as {
        configs: Array<{ address: string; data: string }>; samples: Array<{ address: string; data: string }>;
        mints: Array<{ address: string; data: string; owner: string }>;
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
        if (JSON.stringify(auditConfig(config, report.network, precision)) !== JSON.stringify(row.audit)) throw new Error(`Review mismatch ${row.address}`)
        verified++
    }
    for (const sample of evidence.samples) {
        const bytes = Buffer.from(sample.data, 'base64')
        const decoded = program.coder.accounts.decode('virtualPool', bytes) as VirtualPool
        const fields = readPoolCensusFields(bytes)
        if (fields.config !== decoded.poolState.config.toBase58() || fields.migrated !== (decoded.poolState.isMigrated === 1)) throw new Error('Sample decoding mismatch')
    }
    if (verified !== report.auditedConfigs || evidence.samples.length !== report.validation.checked) throw new Error('Verification counts differ')
    console.log(`Verified ${verified} config hashes and reviews, and ${evidence.samples.length} pool layouts. Full-network totals require replaying the raw scan archive; chain inclusion is not proven.`)
}
