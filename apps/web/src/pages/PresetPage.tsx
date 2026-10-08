import { ReactNode, useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useConnection } from '@solana/wallet-adapter-react'
import { useQuery } from '@tanstack/react-query'
import { PublicKey } from '@solana/web3.js'
import {
    dbcClient,
    Evaluation,
    evaluateConfig,
    LIBRARY,
    PresetStats,
    specFromConfig,
} from '@launchproof/core'
import { CurveChart, EconomicsGrid, FeeChart, LintPanel, LiquidityBar, Panel, SimulationPanel, SupplyBar } from '../components/PresetViews'
import { Address, Badge, Button, Card, Empty, GradeBadge, Progress, Segmented, Skeleton, Stat } from '../components/ui'
import { CATEGORY_LABEL } from '../components/PresetCard'
import { PublishPanel } from '../components/studio/PublishPanel'
import { useListing, usePresetStats, useTokenMetas } from '../lib/queries'
import { useNetwork } from '../lib/network'
import { listingEvaluation, templateEvaluation, useDeferredEvaluation } from '../lib/evaluations'
import { ago, num, pct } from '../lib/format'

function DetailBody({ ev, extraTabs }: { ev: Evaluation; extraTabs?: { id: string; label: string; node: ReactNode }[] }) {
    const [tab, setTab] = useState<string>(extraTabs?.[0]?.id ?? 'curve')
    const a = ev.analyzed
    const tabs = [
        ...(extraTabs ?? []),
        { id: 'curve', label: 'Curve & supply', node: null },
        { id: 'simulate', label: 'Simulate', node: null },
        { id: 'review', label: 'Review', node: null },
    ]
    return (
        <div className="space-y-5">
            <Card>
                <EconomicsGrid a={a} />
            </Card>
            <Segmented value={tab} onChange={setTab} options={tabs.map((t) => ({ value: t.id, label: t.label }))} />
            {extraTabs?.find((t) => t.id === tab)?.node}
            {tab === 'curve' && (
                <>
                    <Panel title="Price path">
                        <CurveChart a={a} />
                    </Panel>
                    <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                        <Panel title="Where the supply goes">
                            <SupplyBar a={a} />
                        </Panel>
                        <Panel title="Who owns graduated liquidity">
                            <LiquidityBar spec={a.spec} />
                        </Panel>
                    </div>
                    <Panel title="Fee schedule">
                        <FeeChart a={a} />
                    </Panel>
                </>
            )}
            {tab === 'simulate' && (
                <Panel title="Simulation" hint="Agent-based market replay on the exact pool math">
                    <SimulationPanel a={a} runs={ev.runs} />
                </Panel>
            )}
            {tab === 'review' && (
                <Panel title="Launch review">
                    <LintPanel report={ev.lint} />
                </Panel>
            )}
        </div>
    )
}

function Header({
    title,
    tagline,
    category,
    tags,
    ev,
    meta,
    actions,
    description,
}: {
    title: string
    tagline: string
    category: keyof typeof CATEGORY_LABEL
    tags: string[]
    ev: Evaluation | Error | null
    meta?: ReactNode
    actions?: ReactNode
    description?: string
}) {
    return (
        <div className="mb-6 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_auto] lg:items-start">
            <div className="min-w-0">
                <div className="mb-2 flex flex-wrap items-center gap-2">
                    <Badge tone="accent">{CATEGORY_LABEL[category] ?? category}</Badge>
                    {tags.map((t) => (
                        <Badge key={t}>{t}</Badge>
                    ))}
                </div>
                <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
                <p className="mt-1 text-[15px] text-ink-2">{tagline}</p>
                {description && <p className="mt-3 max-w-3xl text-[14px] leading-relaxed text-ink-2">{description}</p>}
                {meta && <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-muted">{meta}</div>}
            </div>
            <div className="flex flex-col items-start gap-3 lg:items-end">
                {ev && !(ev instanceof Error) && <GradeBadge grade={ev.lint.grade} score={ev.lint.score} size="lg" />}
                {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
            </div>
        </div>
    )
}

function Launches({ stats, quote }: { stats: PresetStats | undefined; quote: string }) {
    const { network } = useNetwork()
    const metas = useTokenMetas(stats?.pools.map((p) => p.baseMint) ?? [])
    if (!stats) return <Skeleton className="h-40" />
    if (stats.pools.length === 0) return <Empty title="No tokens launched yet">Be the first: launch a token from this preset.</Empty>
    return (
        <Card pad={false} className="overflow-x-auto">
            <table className="w-full text-[13px]">
                <thead>
                    <tr className="border-b border-line text-left text-xs text-muted">
                        <th className="px-4 py-3 font-medium">Token</th>
                        <th className="px-4 py-3 font-medium">Progress to graduation</th>
                        <th className="px-4 py-3 text-right font-medium">Market cap</th>
                        <th className="px-4 py-3 text-right font-medium">Fees generated</th>
                        <th className="px-4 py-3 font-medium">Creator</th>
                    </tr>
                </thead>
                <tbody className="tnum">
                    {stats.pools.map((p) => {
                        const m = metas.data?.get(p.baseMint.toBase58())
                        return (
                            <tr key={p.pool.toBase58()} className="border-b border-line last:border-0 hover:bg-surface-2">
                                <td className="px-4 py-3">
                                    <Link to={`/token/${p.pool.toBase58()}`} className="font-semibold hover:text-accent">
                                        {m ? `${m.name} (${m.symbol})` : p.baseMint.toBase58().slice(0, 8)}
                                    </Link>
                                </td>
                                <td className="px-4 py-3">
                                    <div className="flex items-center gap-3">
                                        <Progress value={p.progress} className="w-32" />
                                        <span className="text-xs text-ink-2">{p.migrated ? 'on DAMM v2' : p.graduated ? 'ready to graduate' : pct(p.progress * 100, 0)}</span>
                                    </div>
                                </td>
                                <td className="px-4 py-3 text-right">
                                    {num(p.mcap)} {quote}
                                </td>
                                <td className="px-4 py-3 text-right">
                                    {num(p.feesQuote)} {quote}
                                </td>
                                <td className="px-4 py-3">
                                    <Address value={p.creator.toBase58()} network={network} />
                                </td>
                            </tr>
                        )
                    })}
                </tbody>
            </table>
        </Card>
    )
}

/** /p/:config: a listed preset, or any DBC config pasted by address. */
export function PresetPage() {
    const { config } = useParams()
    const { network, setNetwork } = useNetwork()
    const { connection } = useConnection()
    const { listing, isLoading } = useListing(config)
    const stats = usePresetStats(listing)

    // Not in the registry? Read the raw config so any launchpad's DBC config can be inspected.
    const raw = useQuery({
        enabled: !isLoading && !listing && !!config,
        queryKey: ['rawconfig', network, config],
        queryFn: async () => {
            const pc = await dbcClient(connection).state.getPoolConfig(new PublicKey(config!))
            if (!pc) throw new Error('No DBC config at this address')
            return pc
        },
        retry: false,
    })

    const ev = useDeferredEvaluation(
        listing ? () => listingEvaluation(listing, network) : raw.data ? () => {
            try {
                return evaluateConfig(specFromConfig(raw.data!, network), raw.data!)
            } catch (e) {
                return e as Error
            }
        } : null,
        [config, listing?.signature, raw.data, network]
    )

    if (isLoading || (!listing && raw.isLoading)) return <Skeleton className="h-96" />
    if (!listing && raw.error) {
        const other = network === 'devnet' ? 'mainnet-beta' : 'devnet'
        return (
            <Empty title="Preset not found">
                {(raw.error as Error).message} on {network === 'devnet' ? 'devnet' : 'mainnet'}.
                <div className="mt-3">
                    <Button size="sm" onClick={() => setNetwork(other)}>
                        Look on {other === 'devnet' ? 'devnet' : 'mainnet'}
                    </Button>
                </div>
            </Empty>
        )
    }

    const quote = ev && !(ev instanceof Error) ? ev.analyzed.spec.quote : 'SOL'
    const s = stats.data ?? undefined
    const launchBtn = (
        <Link to={`/launch/${config}`}>
            <Button variant="primary">Launch a token</Button>
        </Link>
    )

    return (
        <div>
            <Header
                title={listing?.meta.n ?? 'Unlisted DBC config'}
                tagline={listing?.meta.t ?? 'Read straight from chain. Not listed in the Launchproof registry.'}
                description={listing?.meta.d}
                category={listing?.meta.g ?? 'experimental'}
                tags={listing?.meta.k ?? []}
                ev={ev}
                meta={
                    <>
                        <span>
                            Config <Address value={config!} network={network} />
                        </span>
                        {listing && (
                            <>
                                <span>
                                    Author <Address value={listing.author.toBase58()} network={network} />
                                </span>
                                <span>Listed {ago(listing.blockTime)}</span>
                            </>
                        )}
                        {raw.data && (
                            <span>
                                Fee claimer <Address value={raw.data.feeClaimer.toBase58()} network={network} />
                            </span>
                        )}
                    </>
                }
                actions={
                    <>
                        {launchBtn}
                        <Link to={listing ? `/studio?fork=${config}` : `/studio`}>
                            <Button>Fork in Studio</Button>
                        </Link>
                    </>
                }
            />
            {listing && (
                <Card className="mb-5">
                    <div className="grid grid-cols-2 gap-4 sm:grid-cols-5">
                        <Stat label="Tokens launched" value={s ? num(s.launches) : '...'} />
                        <Stat label="Graduated" value={s ? num(s.graduated) : '...'} sub={s ? `${pct(s.graduationRate * 100, 0)} graduation rate` : undefined} />
                        <Stat label="Fees generated" value={s ? `${num(s.feesQuote)} ${quote}` : '...'} />
                        <Stat label="In active curves" value={s ? `${num(s.tvlQuote)} ${quote}` : '...'} />
                        <Stat
                            label="Author's fee share"
                            value={ev && !(ev instanceof Error) ? `${100 - ev.analyzed.spec.fees.creatorSharePct}%` : '...'}
                            sub="of curve trading fees, after the 20% protocol cut"
                        />
                    </div>
                </Card>
            )}
            {ev instanceof Error ? (
                <Empty title="Simulation unavailable for this config">{ev.message}<Link className="mt-3 block text-accent hover:underline" to={`/audit/${config}?network=${network}`}>Open the configuration audit →</Link></Empty>
            ) : ev ? (
                <DetailBody
                    ev={ev}
                    extraTabs={listing ? [{ id: 'launches', label: `Launches${s ? ` (${s.launches})` : ''}`, node: <Launches stats={s} quote={quote} /> }] : undefined}
                />
            ) : (
                <Skeleton className="h-96" />
            )}
        </div>
    )
}

/** /t/:id: a library template that anyone can publish as their own config. */
export function TemplatePage() {
    const { id } = useParams()
    const spec = id ? LIBRARY[id] : undefined
    const ev = useDeferredEvaluation(spec ? () => templateEvaluation(id!) : null, [id])
    const evOk = useMemo(() => (ev && !(ev instanceof Error) ? ev : null), [ev])
    if (!spec) return <Empty title="Template not found" />
    return (
        <div>
            <Header
                title={spec.name}
                tagline={spec.tagline}
                description={spec.description}
                category={spec.category}
                tags={spec.tags}
                ev={ev}
                meta={<span>Library template. Publishing creates a config you own and earn from.</span>}
                actions={
                    <Link to={`/studio?template=${id}`}>
                        <Button>Customize in Studio</Button>
                    </Link>
                }
            />
            <div className="mb-5">
                <PublishPanel spec={spec} lint={evOk?.lint ?? null} />
            </div>
            {evOk ? <DetailBody ev={evOk} /> : <Skeleton className="h-96" />}
        </div>
    )
}
