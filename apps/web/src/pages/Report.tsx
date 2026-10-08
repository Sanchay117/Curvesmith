import { FormEvent, useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { PublicKey } from '@solana/web3.js'
import type { CensusReport, CensusRow } from '@launchproof/core'
import { Button, Card, Empty, Skeleton, TextInput } from '../components/ui'
import { num, short } from '../lib/format'

const count = (n: number) => n.toLocaleString('en-US')
const percent = (n: number, total: number) => total ? `${(100 * n / total).toFixed(1)}%` : '—'

export function useCensus() {
    return useQuery({
        queryKey: ['mainnet-census'],
        queryFn: async () => {
            const response = await fetch('./census-mainnet-beta.json')
            if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) throw new Error('The census snapshot is not available in this build.')
            const report = await response.json() as CensusReport
            if (report.schema !== 'launchproof/census@1' || report.network !== 'mainnet-beta') throw new Error('Invalid census snapshot')
            return report
        },
        staleTime: Infinity, retry: false,
    })
}

export function AuditSearch() {
    const [address, setAddress] = useState('')
    const [error, setError] = useState('')
    const navigate = useNavigate()
    function submit(e: FormEvent) {
        e.preventDefault()
        try { navigate(`/audit/${new PublicKey(address.trim()).toBase58()}?network=mainnet-beta`) }
        catch { setError('Enter a valid Solana config address.') }
    }
    return <form onSubmit={submit} className="mt-6 max-w-2xl">
        <label htmlFor="audit-address" className="mb-2 block text-sm font-medium">Inspect a mainnet DBC config</label>
        <div className="flex flex-col gap-2 sm:flex-row">
            <TextInput id="audit-address" placeholder="Paste config address" value={address} onChange={(e) => { setAddress(e.target.value); setError('') }} />
            <Button type="submit" variant="primary">Audit config →</Button>
        </div>
        <div className="mt-2 text-xs text-muted">Read-only. No wallet needed. SOL, USDC, and custom quote mints.</div>
        {error && <p role="alert" className="mt-2 text-sm text-critical">{error}</p>}
    </form>
}

function ConfigTable({ rows }: { rows: CensusRow[] }) {
    const [query, setQuery] = useState('')
    const [filter, setFilter] = useState('all')
    const [page, setPage] = useState(0)
    const filtered = useMemo(() => rows.filter((r) => {
        const matches = `${r.address} ${r.audit?.quoteMint} ${r.audit?.quoteSymbol ?? ''}`.toLowerCase().includes(query.toLowerCase())
        return matches && (filter === 'all' || r.audit?.findings.some((f) => f.id === filter))
    }), [rows, query, filter])
    const visible = filtered.slice(page * 15, page * 15 + 15)
    return <section className="mt-12" aria-labelledby="config-heading">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-4">
            <div><h2 id="config-heading" className="text-2xl font-semibold tracking-tight">Follow the evidence</h2><p className="mt-1 text-sm text-ink-2">Most-used configs, ranked by observed pool count. Addresses identify configs, not launchpad brands.</p></div>
            <a href="./census-mainnet-beta.json" download className="text-sm font-medium text-accent hover:underline">Download report JSON ↓</a>
        </div>
        <div className="mb-4 flex flex-wrap gap-3">
            <div className="min-w-56 flex-1"><TextInput aria-label="Search configs or quote mints" placeholder="Find config, quote mint, SOL or USDC" value={query} onChange={(e) => { setQuery(e.target.value); setPage(0) }} /></div>
            <select aria-label="Filter by finding" value={filter} onChange={(e) => { setFilter(e.target.value); setPage(0) }} className="rounded-xl border border-line bg-surface px-3 text-sm text-ink">
                <option value="all">All findings</option><option value="unlocked-lp">Majority LP unlocked</option><option value="leftover-supply">Residual supply &gt;5%</option><option value="mint-authority">Mint authority retained</option><option value="no-time-decay">No time decay</option><option value="custom-quote">Custom quote mint</option>
            </select>
        </div>
        <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
            <table className="w-full min-w-[720px] text-left text-sm">
                <thead className="border-b border-line bg-surface-2 text-xs text-muted"><tr>{['Config / quote asset', 'Pools observed', 'Migrated', 'Configured raise', 'Review'].map((s) => <th key={s} className="px-4 py-3 font-medium">{s}</th>)}</tr></thead>
                <tbody>{visible.map((r) => {
                    const flags = r.audit?.findings.filter((f) => f.severity === 'warning' || f.severity === 'critical') ?? []
                    return <tr key={r.address} className="border-b border-line last:border-0 hover:bg-surface-2">
                        <td className="px-4 py-4"><Link to={`/audit/${r.address}?network=mainnet-beta`} className="font-mono font-medium text-accent hover:underline">{short(r.address)} ↗</Link><div className="mt-1 text-xs text-muted">{r.audit?.quoteSymbol ?? (r.audit ? `Mint ${short(r.audit.quoteMint)}` : 'Quote unavailable')}</div></td>
                        <td className="px-4 py-4 font-mono">{count(r.pools)}</td>
                        <td className="px-4 py-4"><span className="font-mono">{percent(r.migrated, r.pools)}</span><div className="mt-1 h-1 w-20 overflow-hidden rounded bg-surface-3"><div className="h-full bg-accent" style={{ width: percent(r.migrated, r.pools) }} /></div></td>
                        <td className="px-4 py-4 font-mono">{r.audit?.raise !== null && r.audit?.raise !== undefined ? `${num(Number(r.audit.raise))} ${r.audit.quoteSymbol ?? 'quote tokens'}` : 'Raw units only'}</td>
                        <td className="max-w-64 px-4 py-4"><span className={flags.length ? 'text-serious' : 'text-ink-2'}>{r.error ? 'Not evaluated' : flags.length ? `${flags.length} flagged ${flags.length === 1 ? 'term' : 'terms'}` : 'No flagged terms'}</span><div className="mt-1 text-xs text-muted">{flags[0]?.title ?? (r.audit?.migration ?? r.error)}</div></td>
                    </tr>
                })}</tbody>
            </table>
            {!visible.length && <p className="p-8 text-center text-muted">No configs match these filters.</p>}
        </div>
        <div className="mt-3 flex items-center justify-between text-xs text-muted"><span>{count(filtered.length)} matching configs · page {page + 1} of {Math.max(1, Math.ceil(filtered.length / 15))}</span><div className="flex gap-2"><Button size="sm" disabled={!page} onClick={() => setPage(page - 1)}>Previous</Button><Button size="sm" disabled={(page + 1) * 15 >= filtered.length} onClick={() => setPage(page + 1)}>Next</Button></div></div>
    </section>
}

export function Report() {
    const report = useCensus()
    const data = report.data
    const reviewed = data?.rows.filter((r) => r.audit) ?? []
    const signals = [
        { title: 'Majority LP initially unlocked', detail: 'More than 50% can be withdrawn after migration.', test: (r: CensusRow) => r.audit!.unlockedLiquidityPct > 50 },
        { title: 'Residual supply above 5%', detail: 'Configured receiver allocation after the migration burn.', test: (r: CensusRow) => r.audit!.leftoverSupplyPct > 5 },
        { title: 'Mint authority retained', detail: 'Additional issuance is permitted by the config.', test: (r: CensusRow) => r.audit!.mintAuthorityRetained === true },
    ]
    return <div>
        <section className="grid gap-8 border-b border-line pb-10 lg:grid-cols-[1.4fr_1fr] lg:items-end">
            <div><div className="mb-4 text-xs font-semibold tracking-[0.16em] text-accent uppercase">Launchproof · State of DBC</div>
                <h1 className="max-w-3xl text-4xl leading-[1.05] font-semibold tracking-tight sm:text-6xl">Read the terms.<br />Before the launch.</h1>
                <p className="mt-5 max-w-xl text-base leading-relaxed text-ink-2">Who can mint more tokens? Who can pull liquidity? Where does the supply go? Inspect the on-chain terms behind Meteora DBC launches, then build a better config.</p>
                <AuditSearch />
            </div>
            <Card className="border-accent/30"><div className="text-xs font-semibold tracking-widest text-accent uppercase">Evidence, then execution</div><ol className="mt-5 space-y-4 text-sm"><li><span className="mr-3 font-mono text-muted">01</span>Review mainnet configuration terms.</li><li><span className="mr-3 font-mono text-muted">02</span>Reproduce the findings from account bytes.</li><li><span className="mr-3 font-mono text-muted">03</span>Design, simulate, launch, and migrate.</li></ol><div className="mt-6 flex gap-3"><Link to="/studio"><Button>Open Studio</Button></Link><Link to="/market"><Button variant="ghost">Explore presets ↗</Button></Link></div><p className="mt-5 border-t border-line pt-4 text-xs leading-relaxed text-muted">Configuration checks identify terms to investigate. They do not certify a token, issuer, or investment as safe.</p></Card>
        </section>
        {report.isLoading && <Skeleton className="mt-8 h-44" />}
        {report.error && <div className="mt-8"><Empty title="Census snapshot unavailable">{(report.error as Error).message} You can still audit a config or explore the Studio.</Empty></div>}
        {data && <>
            <div className="mt-6 flex flex-wrap items-center justify-between gap-2 text-xs text-muted"><span>Mainnet · finalized RPC observations · {new Date(data.observedAt).toLocaleString('en-GB', { timeZone: 'UTC' })} UTC</span><button onClick={() => document.getElementById('methodology')?.scrollIntoView({ behavior: 'smooth' })} className="text-accent hover:underline">Scope & methodology ↓</button></div>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{[
                ['Pools observed', count(data.pools), 'Existing standard DBC pool accounts'],
                ['Configs in use', count(data.configs), 'Distinct configs referenced by those pools'],
                ['Migration flag set', percent(data.migrated, data.pools), `${count(data.migrated)} pools · not a demand metric`],
                ['Audit coverage', percent(data.auditedPools, data.pools), `${count(data.auditedConfigs)} configs · ${count(data.auditedPools)} pools`],
            ].map(([label, value, sub]) => <Card key={label}><div className="text-sm text-ink-2">{label}</div><div className="mt-3 text-3xl font-semibold tracking-tight tabular-nums">{value}</div><div className="mt-2 text-xs text-muted">{sub}</div></Card>)}</div>
            <section className="mt-10"><h2 className="text-2xl font-semibold tracking-tight">Terms that deserve a closer look</h2><p className="mt-2 text-sm text-ink-2">Pool-weighted shares among the {count(data.auditedPools)} pools whose configs were successfully reviewed. Categories overlap.</p><div className="mt-5 grid gap-4 md:grid-cols-3">{signals.map((s) => {
                const n = reviewed.filter(s.test).reduce((sum, r) => sum + r.pools, 0)
                return <Card key={s.title}><div className="text-3xl font-semibold text-accent tabular-nums">{percent(n, data.auditedPools)}</div><h3 className="mt-3 font-medium">{s.title}</h3><p className="mt-1 text-sm text-ink-2">{s.detail}</p><div className="mt-3 text-xs text-muted">{count(n)} observed pools</div></Card>
            })}</div></section>
            <Card className="mt-6"><h2 className="font-semibold">Migration is a state transition, not a popularity score.</h2><p className="mt-2 text-sm leading-relaxed text-ink-2">A pool can meet its threshold under very different curve designs and quote assets. High migration rates do not establish organic demand; low rates do not establish failure. This report makes no claim about bots, wash trading, or fake graduations.</p></Card>
            <ConfigTable rows={data.rows} />
            <section id="methodology" className="mt-12 scroll-mt-24 border-t border-line pt-8"><h2 className="text-2xl font-semibold tracking-tight">Make it reproducible</h2><div className="mt-4 grid gap-6 text-sm leading-relaxed text-ink-2 md:grid-cols-2"><div><h3 className="font-semibold text-ink">What was counted</h3><p className="mt-2">{data.scope}</p><p className="mt-2">Pool scan slots: {data.slots.slice(0, 2).join(' → ')}. {data.duplicateObservations} repeated observations were deduplicated. Raw responses are hashed and retained by the CLI.</p></div><div><h3 className="font-semibold text-ink">What was checked</h3><p className="mt-2">Top {count(data.rows.length)} configs by observed pool count; {data.failures} not evaluated. SDK {data.sdkVersion}; {data.validation.checked} sampled full pool accounts checked against the SDK decoder, {data.validation.mismatches} mismatches. That validates decoding, not RPC completeness.</p><p className="mt-2">Custom quote mints retain their identity and mint precision. Rule thresholds are inspectable in the source. No blanket safety grade is assigned.</p></div></div><pre className="mt-5 overflow-x-auto rounded-xl border border-line bg-surface p-4 text-xs">pnpm cli -n mainnet-beta census --limit 5000</pre><div className="mt-4 flex flex-wrap gap-5 text-sm"><a href="./census-mainnet-beta-evidence.json.gz" download className="font-medium text-accent hover:underline">Download decoded-source account archive ↓</a><a href="https://github.com/Sanchay117/Launchproof/blob/main/docs/CENSUS.md" target="_blank" rel="noreferrer" className="text-accent hover:underline">Full methodology ↗</a><Link to="/about" className="text-accent hover:underline">How the simulator is tested ↗</Link></div></section>
        </>}
    </div>
}
