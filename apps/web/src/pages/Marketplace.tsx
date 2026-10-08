import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueries } from '@tanstack/react-query'
import { useConnection } from '@solana/wallet-adapter-react'
import { PublicKey } from '@solana/web3.js'
import { LIBRARY, LIBRARY_IDS, Listing, PresetCategory } from '@launchproof/core'
import { PresetCard, CATEGORY_LABEL } from '../components/PresetCard'
import { Button, cx, Empty, Segmented, Skeleton, TextInput } from '../components/ui'
import { CountUp, Reveal } from '../components/motion'
import { statsQuery, useListings, usePresetStats, useSnapshot } from '../lib/queries'
import { useNetwork } from '../lib/network'
import { listingEvaluation, templateEvaluation, useDeferredEvaluation } from '../lib/evaluations'
import { ago, num, short } from '../lib/format'

function ListingCard({ l }: { l: Listing }) {
    const { network } = useNetwork()
    const ev = useDeferredEvaluation(() => listingEvaluation(l, network), [l.config.toBase58(), l.signature, network])
    const stats = usePresetStats(l)
    return (
        <PresetCard
            href={`/p/${l.config.toBase58()}`}
            name={l.meta.n}
            tagline={l.meta.t}
            category={l.meta.g}
            evaluation={ev}
            footer={
                <div className="flex items-center justify-between text-xs text-ink-2">
                    <span>
                        {stats.data ? (
                            <>
                                <span className="tnum font-semibold text-ink">{stats.data.launches}</span> launches,{' '}
                                <span className="tnum font-semibold text-ink">{stats.data.graduated}</span> graduated
                            </>
                        ) : (
                            'loading launches...'
                        )}
                    </span>
                    <span className="font-mono text-muted">by {short(l.author.toBase58())}</span>
                </div>
            }
        />
    )
}

function TemplateCard({ id }: { id: string }) {
    const spec = LIBRARY[id]
    const ev = useDeferredEvaluation(() => templateEvaluation(id), [id])
    return (
        <PresetCard
            href={`/t/${id}`}
            name={spec.name}
            tagline={spec.tagline}
            category={spec.category}
            evaluation={ev}
            footer={<span className="text-xs text-ink-2">Template: publish your own copy and earn its fees</span>}
        />
    )
}

const CATEGORIES: Array<PresetCategory | 'all'> = ['all', 'meme', 'community', 'rwa', 'equity', 'ai', 'creator', 'experimental']

/** The search box doubles as the config auditor: a pasted address opens that config's review. */
function asAddress(q: string): string | null {
    const s = q.trim()
    if (s.length < 32 || s.length > 44) return null
    try {
        return new PublicKey(s).toBase58()
    } catch {
        return null
    }
}

export function Marketplace() {
    const { network, rpcUrl } = useNetwork()
    const { connection } = useConnection()
    const listings = useListings()
    const [cat, setCat] = useState<PresetCategory | 'all'>('all')
    const [q, setQ] = useState('')
    const [tab, setTab] = useState<'live' | 'templates'>('live')

    const match =(name: string, tagline: string, category: PresetCategory, tags: string[]) =>
        (cat === 'all' || category === cat) &&
        (!q || `${name} ${tagline} ${tags.join(' ')}`.toLowerCase().includes(q.toLowerCase()))

    const live = useMemo(
        () => (listings.data ?? []).filter((l) => match(l.meta.n, l.meta.t, l.meta.g, l.meta.k)),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [listings.data, cat, q]
    )
    const templates = LIBRARY_IDS.filter((id) => match(LIBRARY[id].name, LIBRARY[id].tagline, LIBRARY[id].category, LIBRARY[id].tags))
    const address = asAddress(q)

    // aggregate stats share their cache with the cards (same query keys)
    const snapshot = useSnapshot()
    const statQueries = useQueries({
        queries: (listings.data ?? []).map((l) => statsQuery(connection, network, rpcUrl, l, snapshot)),
    })
    const totals = statQueries.reduce(
        (acc, s) => {
            if (s.data) {
                acc.launches += s.data.launches
                acc.graduated += s.data.graduated
            }
            return acc
        },
        { launches: 0, graduated: 0 }
    )

    return (
        <div>
            <section className="mb-10 grid grid-cols-1 gap-8 lg:grid-cols-[1.25fr_1fr] lg:items-end">
                <div>
                    <h1 className="lp-pop text-4xl leading-[1.08] font-semibold tracking-tight sm:text-5xl">Presets that pay their authors.</h1>
                    <p className="lp-pop mt-4 max-w-lg text-[16px] leading-relaxed text-ink-2" style={{ animationDelay: '80ms' }}>
                        Every preset is a real DBC config. Launch a token from one, or publish your own and earn on every launch.
                    </p>
                    <div className="lp-pop mt-6 flex flex-wrap gap-2" style={{ animationDelay: '160ms' }}>
                        <Link to="/studio">
                            <Button variant="primary" size="lg">
                                Design a preset
                            </Button>
                        </Link>
                        <Link to="/about">
                            <Button size="lg">How it works</Button>
                        </Link>
                    </div>
                </div>
                <div className="grid grid-cols-3 gap-3">
                    {[
                        { label: 'presets on-chain', value: listings.data ? listings.data.length : null },
                        { label: 'tokens launched', value: listings.data ? totals.launches : null },
                        { label: 'graduated to DAMM v2', value: listings.data ? totals.graduated : null },
                    ].map((s, n) => (
                        <div key={s.label} className="lp-pop rounded-2xl border border-line bg-surface p-4" style={{ animationDelay: `${120 + n * 80}ms` }}>
                            <div className="text-3xl font-semibold tracking-tight">{s.value !== null ? <CountUp value={s.value} duration={900} /> : <Skeleton className="h-8 w-12" />}</div>
                            <div className="mt-1 text-xs text-muted">{s.label}</div>
                        </div>
                    ))}
                </div>
            </section>

            <div className="mb-6 flex flex-wrap items-center gap-2">
                {CATEGORIES.map((c) => (
                    <button
                        key={c}
                        onClick={() => setCat(c)}
                        className={cx(
                            'rounded-full border px-3 py-1 text-[13px] font-medium transition-colors',
                            cat === c ? 'border-accent bg-accent-wash text-ink' : 'border-line text-ink-2 hover:text-ink'
                        )}
                    >
                        {c === 'all' ? 'All' : CATEGORY_LABEL[c]}
                    </button>
                ))}
                <div className="ml-auto w-full sm:w-80">
                    <TextInput placeholder="Search presets, or paste any DBC config" value={q} onChange={(e) => setQ(e.target.value)} />
                </div>
            </div>

            {address && (
                <Link
                    to={`/audit/${address}?network=${network}`}
                    className="mb-8 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-accent bg-accent-wash px-5 py-4 hover:bg-surface-2"
                >
                    <div className="min-w-0">
                        <div className="text-sm font-semibold">Audit this DBC config</div>
                        <div className="mt-0.5 truncate font-mono text-[13px] text-ink-2">{address}</div>
                        <div className="mt-0.5 text-xs text-muted">
                            Any launchpad's config on {network === 'devnet' ? 'devnet' : 'mainnet'}: economics, simulation and a launch review, read straight from chain.
                        </div>
                    </div>
                    <span className="inline-flex h-9 items-center rounded-[10px] bg-accent px-3.5 text-sm font-semibold text-accent-ink">Audit config</span>
                </Link>
            )}

            {!address && (
                <>
                    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
                        <Segmented
                            value={tab}
                            onChange={setTab}
                            options={[
                                { value: 'live', label: `Live on ${network === 'devnet' ? 'devnet' : 'mainnet'}${listings.data ? ` (${live.length})` : ''}` },
                                { value: 'templates', label: `Templates (${templates.length})` },
                            ]}
                        />
                        <span className="text-xs text-muted">
                            {tab === 'templates'
                                ? 'Fork one, tune it, publish it as your own.'
                                : listings.isPlaceholderData && snapshot
                                  ? `Snapshot from ${ago(snapshot.generatedAt)}, refreshing from chain`
                                  : 'Read live from the on-chain registry'}
                        </span>
                    </div>
                    {tab === 'live' && (
                    <section key="live">
                        {listings.isLoading ? (
                            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                                {[0, 1, 2].map((i) => (
                                    <Skeleton key={i} className="h-64" />
                                ))}
                            </div>
                        ) : listings.error ? (
                            <Empty title="Could not read the registry">
                                {(listings.error as Error).message}. Public RPCs rate-limit; set your own endpoint from the network menu.
                            </Empty>
                        ) : live.length === 0 ? (
                            <Empty title="No live presets match">Publish one from the Studio, or start from a template below.</Empty>
                        ) : (
                            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                                {live.map((l, n) => (
                                    <Reveal key={`${l.config.toBase58()}:${l.author.toBase58()}`} delay={(n % 3) * 80}>
                                        <ListingCard l={l} />
                                    </Reveal>
                                ))}
                            </div>
                        )}
                    </section>
                    )}

                    {tab === 'templates' && (
                    <section key="templates">
                        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                            {templates.map((id, n) => (
                                <Reveal key={id} delay={(n % 3) * 80}>
                                    <TemplateCard id={id} />
                                </Reveal>
                            ))}
                        </div>
                    </section>
                    )}
                </>
            )}
        </div>
    )
}
