import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { useQueries } from '@tanstack/react-query'
import { useConnection } from '@solana/wallet-adapter-react'
import { LIBRARY, LIBRARY_IDS, Listing, PresetCategory } from '@curvesmith/core'
import { PresetCard, CATEGORY_LABEL } from '../components/PresetCard'
import { Button, cx, Empty, Skeleton, TextInput } from '../components/ui'
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

export function Marketplace() {
    const { network, rpcUrl } = useNetwork()
    const { connection } = useConnection()
    const listings = useListings()
    const [cat, setCat] = useState<PresetCategory | 'all'>('all')
    const [q, setQ] = useState('')

    const match = (name: string, tagline: string, category: PresetCategory, tags: string[]) =>
        (cat === 'all' || category === cat) &&
        (!q || `${name} ${tagline} ${tags.join(' ')}`.toLowerCase().includes(q.toLowerCase()))

    const live = useMemo(
        () => (listings.data ?? []).filter((l) => match(l.meta.n, l.meta.t, l.meta.g, l.meta.k)),
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [listings.data, cat, q]
    )
    const templates = LIBRARY_IDS.filter((id) => match(LIBRARY[id].name, LIBRARY[id].tagline, LIBRARY[id].category, LIBRARY[id].tags))

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
                    <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-line bg-surface px-3 py-1 text-xs text-ink-2">
                        <span className="size-1.5 rounded-full bg-accent" /> Built on Meteora Dynamic Bonding Curve
                    </div>
                    <h1 className="text-4xl leading-[1.08] font-semibold tracking-tight sm:text-5xl">
                        Launch economics,
                        <br />
                        designed and proven.
                    </h1>
                    <p className="mt-4 max-w-xl text-[15px] leading-relaxed text-ink-2">
                        Curvesmith turns DBC configs into products. Design a curve, simulate it against bots and crowds with the program's exact
                        math, publish it on-chain, and earn the partner fees of every token that launches from it.
                    </p>
                    <div className="mt-6 flex flex-wrap gap-2">
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
                        { label: 'Presets on-chain', value: listings.data ? num(listings.data.length) : null },
                        { label: 'Tokens launched', value: listings.data ? num(totals.launches) : null },
                        { label: 'Graduated to DAMM v2', value: listings.data ? num(totals.graduated) : null },
                    ].map((s) => (
                        <div key={s.label} className="rounded-2xl border border-line bg-surface p-4">
                            <div className="text-2xl font-semibold">{s.value ?? <Skeleton className="h-8 w-12" />}</div>
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
                <div className="ml-auto w-full sm:w-64">
                    <TextInput placeholder="Search presets" value={q} onChange={(e) => setQ(e.target.value)} />
                </div>
            </div>

            <section className="mb-12">
                <div className="mb-4 flex items-baseline justify-between">
                    <h2 className="text-xl font-semibold">Live on {network === 'devnet' ? 'devnet' : 'mainnet'}</h2>
                    <span className="text-xs text-muted">
                        {listings.isPlaceholderData && snapshot
                            ? `Showing a registry snapshot from ${ago(snapshot.generatedAt)} while live chain data loads.`
                            : "Read from the CSR-1 on-chain registry. Only a config's fee claimer can list it."}
                    </span>
                </div>
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
                        {live.map((l) => (
                            <ListingCard key={`${l.config.toBase58()}:${l.author.toBase58()}`} l={l} />
                        ))}
                    </div>
                )}
            </section>

            <section>
                <div className="mb-4 flex items-baseline justify-between">
                    <h2 className="text-xl font-semibold">Template library</h2>
                    <span className="text-xs text-muted">Each one shows off a different DBC capability. Fork, tune, publish.</span>
                </div>
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {templates.map((id) => (
                        <TemplateCard key={id} id={id} />
                    ))}
                </div>
            </section>
        </div>
    )
}
