import { FormEvent, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { PublicKey } from '@solana/web3.js'
import type { CensusReport, CensusRow } from '@launchproof/core'
import { Button, Card, Empty, InfoTip, Skeleton, TextInput } from '../components/ui'
import { CountUp, Reveal, RingMeter } from '../components/motion'
import { AUDIT_EXAMPLES, HeroAudit } from '../components/HeroAudit'
import { num, short } from '../lib/format'

const count = (n: number) => n.toLocaleString('en-US')
const percent = (n: number, total: number) => (total ? `${((100 * n) / total).toFixed(1)}%` : '-')
const PAGE = 15
const PREVIEW = 8

export function useCensus() {
    return useQuery({
        queryKey: ['mainnet-census'],
        queryFn: async () => {
            const response = await fetch('./census-mainnet-beta.json')
            if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('The census snapshot is not available in this build.')
            const report = (await response.json()) as CensusReport
            if (report.schema !== 'launchproof/census@1' || report.network !== 'mainnet-beta') throw new Error('Invalid census snapshot')
            return report
        },
        staleTime: Infinity,
        retry: false,
    })
}

export function AuditSearch({ examples = true }: { examples?: boolean }) {
    const [address, setAddress] = useState('')
    const [error, setError] = useState('')
    const navigate = useNavigate()
    const open = (a: string) => navigate(`/audit/${a}?network=mainnet-beta`)
    function submit(e: FormEvent) {
        e.preventDefault()
        try {
            open(new PublicKey(address.trim()).toBase58())
        } catch {
            setError('That is not a Solana address. Paste a DBC config address.')
        }
    }
    return (
        <form onSubmit={submit} className="mt-8 max-w-xl">
            <div className="flex items-center gap-2 rounded-2xl border border-line-strong bg-surface p-1.5 shadow-[0_0_0_4px_var(--accent-wash)] transition-shadow focus-within:shadow-[0_0_0_6px_var(--accent-wash)]">
                <input
                    id="audit-address"
                    aria-label="Mainnet DBC config address"
                    placeholder="Paste any mainnet DBC config"
                    value={address}
                    onChange={(e) => {
                        setAddress(e.target.value)
                        setError('')
                    }}
                    className="h-11 min-w-0 flex-1 bg-transparent px-3 font-mono text-sm text-ink outline-none placeholder:font-sans placeholder:text-muted"
                />
                <Button type="submit" variant="primary" size="lg">
                    Audit
                </Button>
            </div>
            {error && (
                <p role="alert" className="mt-2 text-sm text-critical">
                    {error}
                </p>
            )}
            {examples && (
                <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-muted">
                    Try one:
                    {AUDIT_EXAMPLES.map((e) => (
                        <button
                            key={e.address}
                            type="button"
                            onClick={() => open(e.address)}
                            className="rounded-full border border-line px-2.5 py-1 font-mono text-ink-2 transition-colors hover:border-accent hover:text-ink"
                        >
                            {short(e.address)} <span className="font-sans text-muted">· {e.label}</span>
                        </button>
                    ))}
                </div>
            )}
        </form>
    )
}

function FindingChips({ row }: { row: CensusRow }) {
    if (row.error) return <span className="text-muted">Not evaluated</span>
    const flags = row.audit?.findings.filter((f) => f.severity === 'warning' || f.severity === 'critical') ?? []
    if (!flags.length) return <span className="inline-flex items-center gap-1.5 text-ink-2"><span className="size-1.5 rounded-full bg-muted" />No flagged terms</span>
    return (
        <div className="flex flex-wrap gap-1.5">
            {flags.map((f) => (
                <span key={f.id} title={f.detail} className="inline-flex items-center gap-1.5 rounded-full bg-surface-2 px-2 py-0.5 text-xs text-ink-2">
                    <span className="size-1.5 rounded-full" style={{ background: f.severity === 'critical' ? 'var(--critical)' : 'var(--serious)' }} />
                    {f.title}
                </span>
            ))}
        </div>
    )
}

function ConfigTable({ rows }: { rows: CensusRow[] }) {
    const [expanded, setExpanded] = useState(false)
    const [query, setQuery] = useState('')
    const [filter, setFilter] = useState('all')
    const [page, setPage] = useState(0)
    const filtered = useMemo(
        () =>
            rows.filter((r) => {
                const matches = `${r.address} ${r.audit?.quoteMint} ${r.audit?.quoteSymbol ?? ''}`.toLowerCase().includes(query.toLowerCase())
                return matches && (filter === 'all' || r.audit?.findings.some((f) => f.id === filter))
            }),
        [rows, query, filter]
    )
    const visible = expanded ? filtered.slice(page * PAGE, page * PAGE + PAGE) : rows.slice(0, PREVIEW)
    return (
        <section aria-labelledby="config-heading">
            <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
                <div>
                    <h2 id="config-heading" className="text-2xl font-semibold tracking-tight">
                        The most-used configs
                    </h2>
                    <p className="mt-1 text-sm text-ink-2">Ranked by observed pools. Click any row for its full audit.</p>
                </div>
                <a href="./census-mainnet-beta.json" download className="text-sm font-medium text-accent hover:underline">
                    Download data ↓
                </a>
            </div>
            {expanded && (
                <div className="mb-4 flex flex-wrap gap-3">
                    <div className="min-w-56 flex-1">
                        <TextInput
                            aria-label="Search configs or quote mints"
                            placeholder="Find a config, quote mint, SOL or USDC"
                            value={query}
                            onChange={(e) => {
                                setQuery(e.target.value)
                                setPage(0)
                            }}
                        />
                    </div>
                    <select
                        aria-label="Filter by finding"
                        value={filter}
                        onChange={(e) => {
                            setFilter(e.target.value)
                            setPage(0)
                        }}
                        className="rounded-[10px] border border-line-strong bg-surface-2 px-3 text-sm text-ink"
                    >
                        <option value="all">All findings</option>
                        <option value="unlocked-lp">Majority LP unlocked</option>
                        <option value="leftover-supply">Residual supply &gt;5%</option>
                        <option value="mint-authority">Legacy mint-authority mode</option>
                        <option value="no-time-decay">No time decay</option>
                        <option value="custom-quote">Custom quote mint</option>
                    </select>
                </div>
            )}
            <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
                <table className="w-full min-w-[680px] text-left text-sm">
                    <thead className="border-b border-line text-xs text-muted">
                        <tr>
                            {['Config', 'Pools observed', 'Migrated', 'Raise', 'Terms to read'].map((s) => (
                                <th key={s} className="px-4 py-3 font-medium">
                                    {s}
                                </th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {visible.map((r, n) => {
                            const share = r.pools ? r.migrated / r.pools : 0
                            return (
                                <tr key={r.address} className="lp-pop border-b border-line transition-colors last:border-0 hover:bg-surface-2" style={{ animationDelay: `${n * 40}ms` }}>
                                    <td className="px-4 py-3.5">
                                        <Link to={`/audit/${r.address}?network=mainnet-beta`} className="font-mono font-medium text-accent hover:underline">
                                            {short(r.address)}
                                        </Link>
                                        <span className="ml-2 text-xs text-muted">{r.audit?.quoteSymbol ?? (r.audit ? 'custom' : '')}</span>
                                    </td>
                                    <td className="tnum px-4 py-3.5 font-medium">{count(r.pools)}</td>
                                    <td className="px-4 py-3.5">
                                        <div className="flex items-center gap-2">
                                            <div className="h-1.5 w-16 overflow-hidden rounded-full bg-surface-3">
                                                <div className="h-full rounded-full bg-accent" style={{ width: `${share * 100}%` }} />
                                            </div>
                                            <span className="tnum text-xs text-ink-2">{percent(r.migrated, r.pools)}</span>
                                        </div>
                                    </td>
                                    <td className="tnum px-4 py-3.5 text-ink-2">
                                        {r.audit?.raise != null ? `${num(Number(r.audit.raise))} ${r.audit.quoteSymbol ?? ''}` : 'raw units'}
                                    </td>
                                    <td className="px-4 py-3.5">
                                        <FindingChips row={r} />
                                    </td>
                                </tr>
                            )
                        })}
                    </tbody>
                </table>
                {!visible.length && <p className="p-8 text-center text-muted">No configs match these filters.</p>}
            </div>
            {expanded ? (
                <div className="mt-3 flex items-center justify-between text-xs text-muted">
                    <span>
                        {count(filtered.length)} configs · page {page + 1} of {Math.max(1, Math.ceil(filtered.length / PAGE))}
                    </span>
                    <div className="flex gap-2">
                        <Button size="sm" disabled={!page} onClick={() => setPage(page - 1)}>
                            Previous
                        </Button>
                        <Button size="sm" disabled={(page + 1) * PAGE >= filtered.length} onClick={() => setPage(page + 1)}>
                            Next
                        </Button>
                    </div>
                </div>
            ) : (
                <div className="mt-4 text-center">
                    <Button onClick={() => setExpanded(true)}>Search all {count(rows.length)} audited configs</Button>
                </div>
            )}
        </section>
    )
}

const SIGNALS = [
    {
        title: 'can have most of their liquidity pulled',
        tip: 'More than 50% of the graduated LP is unlocked for the partner or creator right after migration.',
        color: 'var(--serious)',
        test: (r: CensusRow) => r.audit!.unlockedLiquidityPct > 50,
    },
    {
        title: 'are configured to leave over 5% of supply to the leftover receiver',
        tip: "This is a configured estimate after curve sales, migration allocation, vesting and the migration burn. Actual pool balances and fees can differ.",
        color: 'var(--critical)',
        test: (r: CensusRow) => r.audit!.leftoverSupplyPct > 5,
    },
    {
        title: 'use a legacy mint-authority config mode',
        tip: 'This config flag alone does not establish the actual base mint authority. The observations below inspect one sample pool per flagged config.',
        color: 'var(--s4)',
        test: (r: CensusRow) => r.audit!.mintAuthorityRetained === true,
    },
]

const STEPS = [
    { title: 'Audit', body: 'Read any live config: liquidity, supply, fees, migration.', to: '#audit', cta: 'Paste a config', icon: 'M5 12l4 4L19 6' },
    { title: 'Design and simulate', body: 'Shape a curve, then replay snipers and crowds with SDK quotes and modeled pool transitions.', to: '/studio', cta: 'Open the Studio', icon: 'M4 18c5 0 7-3 9-7s4-6 7-6' },
    { title: 'Publish and earn', body: 'Your preset becomes a real DBC config. Every launch from it pays you fees.', to: '/market', cta: 'Browse reference configs', icon: 'M12 3v18M5 10l7-7 7 7' },
]

export function Report() {
    const report = useCensus()
    const data = report.data
    const reviewed = data?.rows.filter((r) => r.audit) ?? []
    const majorityUnlocked = reviewed.filter((row) => row.audit!.unlockedLiquidityPct > 50)
    const majorityUnlockedPools = majorityUnlocked.reduce((sum, row) => sum + row.pools, 0)
    const creatorDominantPools = majorityUnlocked.filter((row) => row.audit!.creatorUnlockedLiquidityPct > row.audit!.partnerUnlockedLiquidityPct).reduce((sum, row) => sum + row.pools, 0)
    const partnerDominantPools = majorityUnlocked.filter((row) => row.audit!.partnerUnlockedLiquidityPct > row.audit!.creatorUnlockedLiquidityPct).reduce((sum, row) => sum + row.pools, 0)
    return (
        <div>
            {/* hero */}
            <section className="lp-glow -mx-4 -mt-8 px-4 pt-14 pb-16 sm:-mx-6 sm:px-6">
                <div className="mx-auto grid max-w-[1232px] items-center gap-12 lg:grid-cols-[1.1fr_1fr]">
                    <div>
                        <div className="lp-pop inline-flex items-center gap-2 rounded-full border border-line bg-surface/70 px-3 py-1 text-xs text-ink-2">
                            <span className="lp-breathe size-1.5 rounded-full bg-accent" /> State of DBC · mainnet snapshot
                        </div>
                        <h1 className="lp-pop mt-5 text-5xl leading-[1.02] font-semibold tracking-tight sm:text-6xl" style={{ animationDelay: '80ms' }}>
                            Read the terms
                            <br />
                            <span className="bg-gradient-to-r from-accent to-[var(--s1)] bg-clip-text text-transparent">before the launch.</span>
                        </h1>
                        <p className="lp-pop mt-5 max-w-lg text-[17px] leading-relaxed text-ink-2" style={{ animationDelay: '160ms' }}>
                            Who can pull the liquidity? Where does the supply go? Paste any Meteora DBC config and find out in a second.
                        </p>
                        <div className="lp-pop" style={{ animationDelay: '240ms' }}>
                            <AuditSearch />
                        </div>
                    </div>
                    <div className="lp-pop" style={{ animationDelay: '200ms' }}>
                        <HeroAudit rows={data?.rows} />
                    </div>
                </div>
            </section>

            {report.isLoading && <Skeleton className="mt-10 h-40" />}
            {report.error && (
                <div className="mt-10">
                    <Empty title="Census snapshot unavailable">You can still audit any config above, or open the Studio.</Empty>
                </div>
            )}

            {data && (
                <>
                    {/* headline numbers */}
                    <Reveal>
                        <Card className="grid grid-cols-2 gap-y-6 lg:grid-cols-4 lg:divide-x lg:divide-line">
                            {[
                                { value: data.pools, label: 'standard DBC pools observed' },
                                { value: data.configs, label: 'configs behind them' },
                                { value: (100 * data.migrated) / data.pools, label: 'reached migration', pct: true, tip: 'A program flag, not a measure of demand: some configs migrate on their very first buy.' },
                                { value: (100 * data.auditedPools) / data.pools, label: 'of observed pools reviewed', pct: true, tip: `The ${count(data.auditedConfigs)} most-used configs, covering ${count(data.auditedPools)} observed pools.` },
                            ].map((s) => (
                                <div key={s.label} className="px-2 lg:px-6">
                                    <CountUp value={s.value} format={s.pct ? (n) => `${n.toFixed(1)}%` : undefined} className="block text-3xl font-semibold tracking-tight sm:text-4xl" />
                                    <div className="mt-1 flex items-center gap-1.5 text-sm text-ink-2">
                                        {s.label}
                                        {s.tip && <InfoTip>{s.tip}</InfoTip>}
                                    </div>
                                </div>
                            ))}
                        </Card>
                    </Reveal>

                    {data.tail && (
                        <Reveal className="mt-4">
                            <Card className="grid gap-4 text-sm text-ink-2 sm:grid-cols-2">
                                <div>
                                    <div className="font-semibold text-ink">Most-used configs: direct reviews</div>
                                    <p className="mt-1">{count(data.auditedConfigs)} configs account for {count(data.auditedPools)} observed pools ({percent(data.auditedPools, data.pools)}). Findings here are weighted by their observed pool counts.</p>
                                </div>
                                <div>
                                    <div className="font-semibold text-ink">Single-pool configs: sampled estimate</div>
                                    <p className="mt-1">{count(data.tail.populationConfigs)} configs ({percent(data.tail.populationConfigs, data.configs)} of configs) account for {percent(data.tail.populationPools, data.pools)} of observed pools. We reviewed {count(data.tail.evaluated)} of {count(data.tail.sampleSize)} randomly selected configs; finding shares use 95% Wilson intervals.</p>
                                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                                        {[
                                            ['unlocked-lp', 'Majority LP unlocked'],
                                            ['leftover-supply', 'Residual supply'],
                                            ['mint-authority', 'Mint authority'],
                                        ].map(([id, label]) => {
                                            const finding = data.tail!.findings.find((item) => item.id === id)
                                            return finding && <span key={id}>{label}: {(100 * finding.share).toFixed(1)}% (95% CI {(100 * finding.low95).toFixed(1)}–{(100 * finding.high95).toFixed(1)}%)</span>
                                        })}
                                    </div>
                                </div>
                            </Card>
                        </Reveal>
                    )}

                    {/* findings */}
                    <section className="mt-20">
                        <Reveal>
                            <h2 className="text-3xl font-semibold tracking-tight">Among the observed pools we reviewed...</h2>
                        </Reveal>
                        <div className="mt-8 grid gap-4 md:grid-cols-3">
                            {SIGNALS.map((s, n) => {
                                const pools = reviewed.filter(s.test).reduce((sum, r) => sum + r.pools, 0)
                                const share = pools / data.auditedPools
                                return (
                                    <Reveal key={s.title} delay={n * 120}>
                                        <Card className="lp-lift flex h-full items-center gap-5">
                                            <RingMeter value={share} color={s.color} size={104}>
                                                <CountUp value={share * 100} format={(v) => `${v.toFixed(1)}%`} className="text-lg font-semibold" />
                                            </RingMeter>
                                            <div>
                                                <div className="text-[15px] leading-snug font-medium">{s.title}</div>
                                                <div className="mt-2 flex items-center gap-1.5 text-xs text-muted">
                                                    {count(pools)} observed pools <InfoTip>{s.tip}</InfoTip>
                                                </div>
                                            </div>
                                        </Card>
                                    </Reveal>
                                )
                            })}
                        </div>
                        <Reveal>
                            <p className="mt-4 text-xs text-muted">
                                Weighted by observed pool count. A pool can appear in more than one group. These are permissions in the config, not observed behaviour.
                            </p>
                            <p className="mt-2 text-sm text-ink-2">
                                Among {count(majorityUnlockedPools)} reviewed pools with majority LP initially unlocked, the creator side has the larger unlocked share in {count(creatorDominantPools)} ({percent(creatorDominantPools, majorityUnlockedPools)}), and the partner/launchpad side in {count(partnerDominantPools)} ({percent(partnerDominantPools, majorityUnlockedPools)}). Ties make up the remainder. For unmigrated pools, these terms would apply at migration.
                            </p>
                            {data.residualReceivers && <p className="mt-2 text-sm text-ink-2">
                                The leftover receiver is the config's own fee claimer in {(100 * data.residualReceivers.sameFeeClaimerShare).toFixed(2)}% of these pools ({count(data.residualReceivers.sameFeeClaimerPools)} of {count(data.residualReceivers.pools)}). This compares configured addresses, not observed withdrawals.
                            </p>}
                            {data.mintAuthorities && <p className="mt-2 text-sm text-ink-2">
                                Of {data.mintAuthorities.top.flaggedConfigs} flagged top configs, one base mint was checked per config: {data.mintAuthorities.top.set} still have a mint authority, {data.mintAuthorities.top.revoked} have it revoked, and {data.mintAuthorities.top.unavailable} were unavailable. An observed authority can authorize additional issuance; these samples do not establish the state of every pool using the config. The single-pool tail sample has {data.mintAuthorities.tail.set} set, {data.mintAuthorities.tail.revoked} revoked, and {data.mintAuthorities.tail.unavailable} unavailable among {data.mintAuthorities.tail.flaggedConfigs} flagged configs.
                            </p>}
                        </Reveal>
                    </section>

                    {data.operators && (
                        <section className="mt-20">
                            <Reveal>
                                <h2 className="text-2xl font-semibold tracking-tight">Who is listed as fee claimer?</h2>
                                <p className="mt-2 text-sm text-ink-2">{count(data.operators.distinctFeeClaimers)} distinct fee-claimer addresses appear in configs behind {count(data.operators.matchedPools)} observed pools ({percent(data.operators.matchedPools, data.pools)}). This groups on-chain addresses, not verified launchpad identities.</p>
                            </Reveal>
                            <div className="mt-5 grid gap-2 sm:grid-cols-2">
                                {data.operators.top.slice(0, 8).map((operator) => (
                                    <div key={operator.feeClaimer} className="rounded-xl border border-line bg-surface p-3">
                                        <div className="flex items-center justify-between gap-2 text-xs">
                                            <span className="font-mono text-ink-2" title={operator.feeClaimer}>{short(operator.feeClaimer)}</span>
                                            <span className="tnum text-ink">{count(operator.pools)} pools</span>
                                        </div>
                                        <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-surface-3">
                                            <div className="h-full rounded-full bg-accent" style={{ width: `${100 * operator.pools / data.operators!.top[0].pools}%` }} />
                                        </div>
                                    </div>
                                ))}
                            </div>
                            <p className="mt-2 text-xs text-muted">Counts join current config accounts to the observed pool scan. Missing or closed configs are excluded from the matched total.</p>
                        </section>
                    )}

                    {/* table */}
                    <div className="mt-20">
                        <Reveal>
                            <ConfigTable rows={data.rows} />
                        </Reveal>
                    </div>

                    {/* then build */}
                    <section className="mt-24">
                        <Reveal>
                            <h2 className="text-3xl font-semibold tracking-tight">Found a bad one? Build better.</h2>
                        </Reveal>
                        <div className="mt-8 grid gap-4 md:grid-cols-3">
                            {STEPS.map((s, n) => (
                                <Reveal key={s.title} delay={n * 120}>
                                    <Link
                                        to={s.to === '#audit' ? '/' : s.to}
                                        onClick={(e) => {
                                            if (s.to !== '#audit') return
                                            e.preventDefault()
                                            window.scrollTo({ top: 0, behavior: 'smooth' })
                                            document.getElementById('audit-address')?.focus({ preventScroll: true })
                                        }}
                                        className="lp-lift group block h-full rounded-2xl border border-line bg-surface p-6 text-left"
                                    >
                                        <div className="grid size-11 place-items-center rounded-xl bg-accent-wash text-accent">
                                            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                                                <path d={s.icon} />
                                            </svg>
                                        </div>
                                        <div className="mt-5 flex items-center gap-2 text-xs font-medium text-muted">
                                            <span className="font-mono">0{n + 1}</span>
                                        </div>
                                        <h3 className="mt-1 text-lg font-semibold">{s.title}</h3>
                                        <p className="mt-2 text-sm leading-relaxed text-ink-2">{s.body}</p>
                                        <div className="mt-5 text-sm font-semibold text-accent">
                                            {s.cta} <span className="inline-block transition-transform group-hover:translate-x-1">→</span>
                                        </div>
                                    </Link>
                                </Reveal>
                            ))}
                        </div>
                    </section>

                    {/* methodology, folded away */}
                    <Reveal>
                        <details id="methodology" className="group mt-20 rounded-2xl border border-line bg-surface p-5 [&_summary::-webkit-details-marker]:hidden">
                            <summary className="flex cursor-pointer list-none items-center justify-between gap-4">
                                <div>
                                    <div className="font-semibold">How this was measured</div>
                                    <div className="mt-0.5 text-xs text-muted">
                                        Mainnet, finalized. Latest supporting read: {new Date(data.observedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}. Reproducible from the CLI.
                                    </div>
                                </div>
                                <span className="text-muted transition-transform group-open:rotate-180">⌄</span>
                            </summary>
                            <div className="mt-5 grid gap-6 border-t border-line pt-5 text-sm leading-relaxed text-ink-2 md:grid-cols-2">
                                <div>
                                    <h3 className="font-semibold text-ink">What was counted</h3>
                                    <p className="mt-2">{data.scope}</p>
                                    <p className="mt-2">
                                        Pool-scan slots {data.slots.slice(0, 2).join(' to ')}. {data.duplicateObservations} repeated observations removed.
                                    </p>
                                </div>
                                {data.phases && <div className="space-y-2">
                                    <h3 className="font-semibold text-ink">Collection windows (UTC)</h3>
                                    {Object.entries(data.phases).map(([key, phase]) => <p key={key}>
                                        {{ poolScan: 'Pool scan', operators: 'Fee-claimer scan', tailReads: 'Tail reads', topReads: 'Top config and quote reads', decodeValidation: 'Decode validation', mintAuthorities: 'Base mint observations' }[key] ?? key}: {phase.firstObservedAt.replace('T', ' ').replace('Z', ' UTC')} to {phase.lastObservedAt.replace('T', ' ').replace('Z', ' UTC')}. Slots {phase.minSlot} to {phase.maxSlot}. {phase.estimatedTimes ? 'Times estimated from cache file modification times; original fetch timestamps were not recorded.' : 'Recorded fetch times.'}
                                    </p>)}
                                </div>}
                                <div>
                                    <h3 className="font-semibold text-ink">What was checked</h3>
                                    <p className="mt-2">
                                        Top {count(data.rows.length)} configs, {data.failures} not evaluated. Decode check: all {data.validation.checked} sampled pool accounts matched SDK {data.sdkVersion}; a mismatch aborts the run. Migration is a program flag, not proof of demand, and no safety grade is assigned.
                                    </p>
                                </div>
                            </div>
                            <pre className="mt-5 overflow-x-auto rounded-xl bg-surface-2 p-4 text-xs">pnpm cli -n mainnet-beta census --limit 5000</pre>
                            <div className="mt-4 flex flex-wrap gap-5 text-sm">
                                <a href="./census-mainnet-beta-evidence.json.gz" download className="font-medium text-accent hover:underline">
                                    Evidence archive ↓
                                </a>
                                <a href="https://github.com/Sanchay117/Launchproof/blob/main/docs/CENSUS.md" target="_blank" rel="noreferrer" className="text-accent hover:underline">
                                    Full methodology ↗
                                </a>
                                <Link to="/about" className="text-accent hover:underline">
                                    How the simulator is tested
                                </Link>
                            </div>
                        </details>
                    </Reveal>
                </>
            )}
        </div>
    )
}
