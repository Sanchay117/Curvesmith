/**
 * Registry snapshots: a static JSON copy of the marketplace (listings + per-preset stats)
 * shipped with the web build, so the first paint never waits on a throttled public RPC.
 * The app shows the snapshot immediately and replaces it with live chain data as it arrives
 * (stale-while-revalidate).
 *
 * Config accounts are stored as their raw on-chain bytes and decoded with the DBC program's
 * own account coder, exactly like live data, so a snapshot cannot drift from the real layout.
 */
import { Connection, PublicKey } from '@solana/web3.js'
import { createDbcProgram, PoolConfig } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { LaunchSummary, PresetStats } from './chain'
import { DEFAULT_RPC, Network } from './constants'
import { Listing, ListingMeta } from './registry'

export interface SnapshotPool extends Omit<LaunchSummary, 'pool' | 'baseMint' | 'creator'> {
    pool: string
    baseMint: string
    creator: string
}

export interface SnapshotStats extends Omit<PresetStats, 'pools' | 'snapshots'> {
    pools: SnapshotPool[]
}

export interface RegistrySnapshot {
    v: 1
    network: Network
    generatedAt: number
    listings: Array<{
        config: string
        author: string
        signature: string
        blockTime: number | null
        meta: ListingMeta
        /** Raw config account data, base64. */
        data: string
    }>
    stats: Record<string, SnapshotStats>
}

export function buildSnapshot(
    network: Network,
    listings: Listing[],
    rawConfigs: Map<string, Uint8Array>,
    stats: Map<string, PresetStats>
): RegistrySnapshot {
    const out: RegistrySnapshot = { v: 1, network, generatedAt: Math.floor(Date.now() / 1000), listings: [], stats: {} }
    for (const l of listings) {
        const key = l.config.toBase58()
        const raw = rawConfigs.get(key)
        if (!raw) continue
        out.listings.push({
            config: key,
            author: l.author.toBase58(),
            signature: l.signature,
            blockTime: l.blockTime,
            meta: l.meta,
            data: Buffer.from(raw).toString('base64'),
        })
        const st = stats.get(key)
        if (st) {
            out.stats[key] = {
                launches: st.launches,
                graduated: st.graduated,
                graduationRate: st.graduationRate,
                tvlQuote: st.tvlQuote,
                feesQuote: st.feesQuote,
                pools: st.pools.map((p) => ({ ...p, pool: p.pool.toBase58(), baseMint: p.baseMint.toBase58(), creator: p.creator.toBase58() })),
            }
        }
    }
    return out
}

export function listingsFromSnapshot(snap: RegistrySnapshot, connection?: Connection): Listing[] {
    const { program } = createDbcProgram(connection ?? new Connection(DEFAULT_RPC[snap.network]))
    const out: Listing[] = []
    for (const l of snap.listings) {
        try {
            const poolConfig = program.coder.accounts.decode('poolConfig', Buffer.from(l.data, 'base64')) as PoolConfig
            out.push({
                config: new PublicKey(l.config),
                author: new PublicKey(l.author),
                signature: l.signature,
                blockTime: l.blockTime,
                meta: l.meta,
                poolConfig,
            })
        } catch {
            /* skip an entry that no longer decodes (program upgraded its layout) */
        }
    }
    return out
}

/** Stats for display only: `snapshots` is empty, so anything that builds transactions waits for live data. */
export function statsFromSnapshot(s: SnapshotStats): PresetStats {
    return {
        ...s,
        pools: s.pools.map((p) => ({ ...p, pool: new PublicKey(p.pool), baseMint: new PublicKey(p.baseMint), creator: new PublicKey(p.creator) })),
        snapshots: [],
    }
}
