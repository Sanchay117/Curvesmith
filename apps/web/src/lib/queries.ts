import { useConnection } from '@solana/wallet-adapter-react'
import { useQuery } from '@tanstack/react-query'
import { Connection, PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import {
    chainTime,
    evaluateConfig,
    evaluatePreset,
    fetchListings,
    fetchRegistryDelta,
    mergeListings,
    fetchTokenMetas,
    Listing,
    listingsFromSnapshot,
    loadPool,
    Network,
    presetStats,
    PresetSpec,
    RegistrySnapshot,
    specFromConfig,
    statsFromSnapshot,
    withRetry,
} from '@launchproof/core'
import { useEffect, useMemo, useState } from 'react'
import { useNetwork } from './network'

/**
 * The static registry snapshot shipped with the build (written by `launchproof snapshot`).
 * Pages paint from it immediately while live chain reads catch up: stale-while-revalidate.
 */
export function useSnapshot(): RegistrySnapshot | null {
    return useSnapshotQuery().data ?? null
}

function useSnapshotQuery() {
    const { network } = useNetwork()
    return useQuery({
        queryKey: ['snapshot', network],
        queryFn: async () => {
            const res = await fetch(`./registry-${network}.json`)
            if (!res.ok) return null
            const snap = (await res.json()) as RegistrySnapshot
            return snap?.v === 1 && snap.network === network ? snap : null
        },
        staleTime: Infinity,
        retry: false,
    })
}

/** Runs at most `n` tasks at once; public RPCs answer bursts of program scans with 429s. */
function limiter(n: number) {
    let active = 0
    const queue: Array<() => void> = []
    const next = () => {
        if (active < n && queue.length) {
            active++
            queue.shift()!()
        }
    }
    return <T,>(fn: () => Promise<T>) =>
        new Promise<T>((resolve, reject) => {
            queue.push(() =>
                fn()
                    .then(resolve, reject)
                    .finally(() => {
                        active--
                        next()
                    })
            )
            next()
        })
}
// Registry scans and preset stats are the heavy reads (getTransaction batches, getProgramAccounts):
// one at a time keeps a fresh page load under the public RPC's burst limit.
const heavy = limiter(1)

export function useListings({ enabled = true }: { enabled?: boolean } = {}) {
    const { connection } = useConnection()
    const { network, rpcUrl } = useNetwork()
    const snapshotQuery = useSnapshotQuery()
    const snapshot = snapshotQuery.data ?? null
    const placeholder = useMemo(() => (snapshot ? listingsFromSnapshot(snapshot, connection) : undefined), [snapshot, connection])
    return useQuery({
        queryKey: ['listings', network, rpcUrl],
        queryFn: async () => {
            try {
                // with a snapshot, read only registry entries newer than its newest listing (usually
                // none or a few) and merge them in; without one, read the whole registry
                const newest = snapshot?.listings.reduce((a, b) => ((b.blockTime ?? 0) > (a.blockTime ?? 0) ? b : a), snapshot.listings[0])
                if (placeholder && newest) {
                    const delta = await heavy(() => withRetry(() => fetchRegistryDelta(connection, newest.signature), 4))
                    return mergeListings(placeholder, delta)
                }
                return await heavy(() => withRetry(() => fetchListings(connection), 4))
            } catch (e) {
                // a throttled RPC should degrade to the snapshot, not to an error page
                if (placeholder) return placeholder
                throw e
            }
        },
        // wait for the shipped snapshot (a static file, fast) so the read can be incremental
        enabled: enabled && !snapshotQuery.isPending,
        staleTime: 5 * 60_000,
        placeholderData: placeholder,
    })
}

export function useListing(config: string | undefined) {
    const listings = useListings()
    const listing = useMemo(
        () => listings.data?.find((l) => l.config.toBase58() === config),
        [listings.data, config]
    )
    // The snapshot placeholder can predate a preset (e.g. one published minutes ago), so a miss in
    // it is not final: keep loading until the live registry read has ruled the config out.
    const pending = !listing && listings.isPlaceholderData && listings.isFetching
    return { ...listings, listing, isLoading: listings.isLoading || pending }
}

export function specOfListing(l: Listing, network: 'devnet' | 'mainnet-beta'): PresetSpec {
    return specFromConfig(l.poolConfig, network, l.meta)
}

/**
 * One definition of the stats query so cards, totals and Earnings share a cache entry.
 * Pass a snapshot to show its (display-only) stats while the live scan runs.
 */
export function statsQuery(connection: Connection, network: Network, rpcUrl: string, l: Listing, snapshot?: RegistrySnapshot | null) {
    const key = l.config.toBase58()
    const cached = snapshot?.stats[key] ? statsFromSnapshot(snapshot.stats[key]) : undefined
    return {
        queryKey: ['stats', network, rpcUrl, key],
        queryFn: async () => {
            try {
                return await heavy(() =>
                    withRetry(() => presetStats(connection, l.config, l.poolConfig, specOfListing(l, network).quote === 'SOL' ? 9 : 6), 4)
                )
            } catch (e) {
                if (cached) return cached
                throw e
            }
        },
        // Snapshot stats count as fresh data from the moment the snapshot was written, so cards
        // only rescan the chain (getProgramAccounts, the most throttled call) once it is hours old.
        staleTime: 3 * 60 * 60_000,
        initialData: cached,
        initialDataUpdatedAt: cached && snapshot ? snapshot.generatedAt * 1000 : undefined,
    }
}

/** `live` keeps polling (a preset's own page); cards and totals read once per staleTime. */
export function usePresetStats(l: Listing | undefined, { live = false }: { live?: boolean } = {}) {
    const { connection } = useConnection()
    const { network, rpcUrl } = useNetwork()
    const snapshot = useSnapshot()
    return useQuery({
        ...(l ? statsQuery(connection, network, rpcUrl, l, snapshot) : { queryKey: ['stats', 'none'], queryFn: async () => null }),
        enabled: !!l,
        refetchInterval: live ? 60_000 : false,
    })
}

export function usePool(address: string | undefined) {
    const { connection } = useConnection()
    const { network, rpcUrl } = useNetwork()
    return useQuery({
        enabled: !!address,
        queryKey: ['pool', network, rpcUrl, address],
        queryFn: () => loadPool(connection, new PublicKey(address!)),
        refetchInterval: 6_000,
    })
}

/**
 * The chain's clock, ticking every second. Fee schedules decay with chain time, so quotes need
 * a current "now". Polling the RPC for it goes stale under rate limits; instead, sync once a
 * minute and advance locally (slots at ~400ms).
 */
export function useChainClock(): { unix: number; slot: number } | null {
    const { connection } = useConnection()
    const { network, rpcUrl } = useNetwork()
    const sync = useQuery({
        queryKey: ['clock', network, rpcUrl],
        queryFn: async () => ({ ...(await chainTime(connection)), local: Date.now() / 1000 }),
        staleTime: 60_000,
        refetchInterval: 60_000,
    })
    const [tick, setTick] = useState(0)
    useEffect(() => {
        const id = setInterval(() => setTick((t) => t + 1), 1000)
        return () => clearInterval(id)
    }, [])
    return useMemo(() => {
        if (!sync.data) return null
        const dt = Date.now() / 1000 - sync.data.local
        return { unix: Math.floor(sync.data.unix + dt), slot: Math.floor(sync.data.slot + dt / 0.4) }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sync.data, tick])
}

export function useTokenMetas(mints: PublicKey[]) {
    const { connection } = useConnection()
    const { network, rpcUrl } = useNetwork()
    const key = mints.map((m) => m.toBase58()).sort().join(',')
    return useQuery({
        enabled: mints.length > 0,
        queryKey: ['metas', network, rpcUrl, key],
        queryFn: () => fetchTokenMetas(connection, mints),
        staleTime: 5 * 60_000,
    })
}

/** Raw token balance (base units) for owner's ATA of `mint`, trying both token programs. */
export function useTokenBalance(owner: PublicKey | null, mint: PublicKey | undefined, token2022 = false) {
    const { connection } = useConnection()
    const { network, rpcUrl } = useNetwork()
    return useQuery({
        enabled: !!owner && !!mint,
        queryKey: ['bal', network, rpcUrl, owner?.toBase58(), mint?.toBase58()],
        queryFn: async () => {
            const ata = getAssociatedTokenAddressSync(mint!, owner!, false, token2022 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID)
            const r = await connection.getTokenAccountBalance(ata).catch(() => null)
            return r ? BigInt(r.value.amount) : 0n
        },
        refetchInterval: 8_000,
    })
}

export function useSolBalance(owner: PublicKey | null) {
    const { connection } = useConnection()
    const { network, rpcUrl } = useNetwork()
    return useQuery({
        enabled: !!owner,
        queryKey: ['sol', network, rpcUrl, owner?.toBase58()],
        queryFn: () => connection.getBalance(owner!),
        refetchInterval: 10_000,
    })
}

/** Memoized evaluation (analysis + simulations + lint) for a local design. */
export function useEvaluation(spec: PresetSpec | null) {
    return useMemo(() => {
        if (!spec) return { evaluation: null, error: null }
        try {
            return { evaluation: evaluatePreset(spec), error: null }
        } catch (e) {
            return { evaluation: null, error: (e as Error).message }
        }
    }, [spec])
}

export function useListingEvaluation(listing: Listing | undefined, network: 'devnet' | 'mainnet-beta') {
    return useMemo(() => {
        if (!listing) return null
        try {
            const spec = specOfListing(listing, network)
            return evaluateConfig(spec, listing.poolConfig)
        } catch {
            return null
        }
    }, [listing, network])
}
