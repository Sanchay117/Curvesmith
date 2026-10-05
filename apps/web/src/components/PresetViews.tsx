import { ReactNode, useMemo, useState } from 'react'
import Decimal from 'decimal.js'
import BN from 'bn.js'
import {
    AnalyzedPreset,
    Cohort,
    LintReport,
    PresetSpec,
    ScenarioResult,
    SCENARIOS,
    simulate,
} from '@curvesmith/core'
import { LineChart } from './charts/LineChart'
import { Card, cx, GradeBadge, InfoTip, Segmented, SectionTitle, SeverityIcon, Stat } from './ui'
import { bps, duration, num, pct, price } from '../lib/format'

// ---------------------------------------------------------------------------------------
// Curve
// ---------------------------------------------------------------------------------------

export function CurveChart({
    a,
    compare,
    current,
    height = 280,
}: {
    a: AnalyzedPreset
    compare?: { a: AnalyzedPreset; label: string }
    current?: { raised: number; label: string }
    height?: number
}) {
    const [xMode, setXMode] = useState<'sold' | 'raised'>('sold')
    const [yMode, setYMode] = useState<'mcap' | 'price'>('mcap')
    const [log, setLog] = useState(a.analysis.maxMultiple > 30)
    const q = a.spec.quote
    const toSeries = (p: AnalyzedPreset, id: string, label: string, color: string, dashed = false) => ({
        id,
        label,
        color,
        dashed,
        area: !dashed,
        points: p.curve.map((c) => ({
            x: xMode === 'sold' ? (c.sold / p.spec.token.supply) * 100 : c.raised,
            y: yMode === 'mcap' ? c.mcap : c.price,
        })),
    })
    const series = [toSeries(a, 'main', a.spec.name, 'var(--s1)')]
    if (compare) series.push(toSeries(compare.a, 'cmp', compare.label, 'var(--s2)', true))

    let dot
    if (current) {
        const pt = a.curve.reduce((best, c) => (Math.abs(c.raised - current.raised) < Math.abs(best.raised - current.raised) ? c : best))
        dot = {
            x: xMode === 'sold' ? (pt.sold / a.spec.token.supply) * 100 : pt.raised,
            y: yMode === 'mcap' ? pt.mcap : pt.price,
            label: current.label,
        }
    }

    return (
        <div>
            <div className="mb-3 flex flex-wrap items-center gap-2">
                <Segmented
                    size="sm"
                    value={yMode}
                    onChange={setYMode}
                    options={[
                        { value: 'mcap', label: 'Market cap' },
                        { value: 'price', label: 'Price' },
                    ]}
                />
                <Segmented
                    size="sm"
                    value={xMode}
                    onChange={setXMode}
                    options={[
                        { value: 'sold', label: 'vs supply sold' },
                        { value: 'raised', label: `vs ${q} raised` },
                    ]}
                />
                <Segmented
                    size="sm"
                    value={log ? 'log' : 'lin'}
                    onChange={(v) => setLog(v === 'log')}
                    options={[
                        { value: 'lin', label: 'Linear' },
                        { value: 'log', label: 'Log' },
                    ]}
                />
            </div>
            <LineChart
                series={series}
                height={height}
                yLog={log}
                yMin={log ? undefined : 0}
                xFormat={(x) => (xMode === 'sold' ? `${num(x, { digits: 0 })}%` : num(x))}
                xTooltip={(x) => (xMode === 'sold' ? `${num(x, { digits: 1 })}% of supply sold` : `${num(x)} ${q} raised`)}
                xLabel={xMode === 'sold' ? 'share of total supply bought from the curve' : `${q} paid into the curve`}
                yFormat={(y) => (yMode === 'mcap' ? `${num(y)}` : price(y))}
                dots={dot ? [dot] : []}
            />
        </div>
    )
}

export function FeeChart({ a, height = 180 }: { a: AnalyzedPreset; height?: number }) {
    return (
        <LineChart
            height={height}
            series={[{ id: 'fee', label: 'Base fee', color: 'var(--s2)', step: true, area: true, points: a.feeCurve.map((f) => ({ x: f.t, y: f.bps })) }]}
            xFormat={(x) => duration(x)}
            xTooltip={(x) => `${duration(x)} after launch`}
            xLabel="time since launch"
            yFormat={(y) => bps(y)}
            yMin={0}
        />
    )
}

// ---------------------------------------------------------------------------------------
// Economics
// ---------------------------------------------------------------------------------------

export function EconomicsGrid({ a }: { a: AnalyzedPreset }) {
    const x = a.analysis
    const q = x.quoteSymbol
    return (
        <div className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4">
            <Stat label="Graduation raise" value={`${num(x.raise)} ${q}`} sub={`${num(x.graduationQuote)} ${q} seeds DAMM v2`} />
            <Stat label="Market cap" value={`${num(x.startMcap)} to ${num(x.endMcap)}`} sub={`${q}, ${num(x.maxMultiple, { digits: 1 })}x range`} />
            <Stat label="Sold on curve" value={pct(x.soldPct)} sub={`${pct(x.liquidityPct)} paired in LP`} />
            <Stat label="Average buyer at graduation" value={`${num(x.avgBuyerMultiple, { digits: 2 })}x`} sub={`avg entry ${price(x.avgPrice)} ${q}`} />
            <Stat label="Fee" value={`${bps(x.fee.startBps)} to ${bps(x.fee.endBps)}`} sub={x.fee.decaySec ? `decays over ${duration(x.fee.decaySec)}` : 'flat'} />
            <Stat label="Opening impact" value={pct(x.openingImpactPct)} sub={`buying 1% of the raise at t=0`} />
            <Stat label="Graduated pool impact" value={pct(x.graduatedImpactPct, 2)} sub={`one ${num(x.refTrade)} ${q} buy after graduation`} />
            <Stat label="Curve segments" value={`${x.segments} / 16`} sub={a.spec.pricing.shape.kind.replace('-', ' ')} />
        </div>
    )
}

interface Segment {
    label: string
    value: number
    color: string
}

/** Horizontal stacked bar with 2px surface gaps between segments and a legend. */
export function StackBar({ segments, format }: { segments: Segment[]; format: (v: number) => string }) {
    const total = segments.reduce((s, x) => s + x.value, 0) || 1
    const shown = segments.filter((s) => s.value > 0)
    return (
        <div>
            <div className="flex h-3 w-full gap-[2px] overflow-hidden rounded-[4px]">
                {shown.map((s) => (
                    <div
                        key={s.label}
                        title={`${s.label}: ${format(s.value)}`}
                        style={{ width: `${(s.value / total) * 100}%`, background: s.color, minWidth: 3 }}
                        className="h-full first:rounded-l-[4px] last:rounded-r-[4px]"
                    />
                ))}
            </div>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
                {shown.map((s) => (
                    <span key={s.label} className="inline-flex items-center gap-1.5 text-ink-2">
                        <span className="size-2.5 rounded-[3px]" style={{ background: s.color }} />
                        {s.label}
                        <span className="tnum font-semibold text-ink">{format(s.value)}</span>
                    </span>
                ))}
            </div>
        </div>
    )
}

export function SupplyBar({ a }: { a: AnalyzedPreset }) {
    const x = a.analysis
    return (
        <StackBar
            format={(v) => pct(v)}
            segments={[
                { label: 'Sold on curve', value: x.soldPct, color: 'var(--s1)' },
                { label: 'Graduated liquidity', value: x.liquidityPct, color: 'var(--s3)' },
                { label: 'Creator allocation', value: x.creatorAllocationPct, color: 'var(--s4)' },
                { label: 'Leftover', value: x.leftoverPct, color: 'var(--muted)' },
            ]}
        />
    )
}

export function LiquidityBar({ spec }: { spec: PresetSpec }) {
    const { partner, creator } = spec.lp
    return (
        <StackBar
            format={(v) => `${num(v, { digits: 0 })}%`}
            segments={[
                { label: 'Author locked', value: partner.locked, color: 'var(--s1)' },
                { label: 'Author vesting', value: partner.vesting?.pct ?? 0, color: 'var(--s3)' },
                { label: 'Author unlocked', value: partner.unlocked, color: 'var(--s2)' },
                { label: 'Creator locked', value: creator.locked, color: 'var(--s5)' },
                { label: 'Creator vesting', value: creator.vesting?.pct ?? 0, color: 'var(--s4)' },
                { label: 'Creator unlocked', value: creator.unlocked, color: 'var(--critical)' },
            ]}
        />
    )
}

// ---------------------------------------------------------------------------------------
// Lint
// ---------------------------------------------------------------------------------------

export function LintPanel({ report, compact }: { report: LintReport; compact?: boolean }) {
    const list = compact ? report.findings.filter((f) => f.severity !== 'good').slice(0, 4) : report.findings
    return (
        <div>
            <div className="mb-3 flex items-center justify-between">
                <GradeBadge grade={report.grade} score={report.score} />
                <div className="flex gap-3 text-xs text-muted">
                    {(['critical', 'warning', 'info', 'good'] as const).map((s) => {
                        const n = report.findings.filter((f) => f.severity === s).length
                        return n ? (
                            <span key={s} className="inline-flex items-center gap-1">
                                <SeverityIcon severity={s} /> {n} {s}
                            </span>
                        ) : null
                    })}
                </div>
            </div>
            <ul className="space-y-2">
                {list.map((f) => (
                    <li key={f.id + f.title} className="flex gap-2.5 rounded-xl bg-surface-2 px-3 py-2.5">
                        <SeverityIcon severity={f.severity} />
                        <div className="min-w-0">
                            <div className="text-[13px] font-semibold">{f.title}</div>
                            <div className="mt-0.5 text-xs leading-relaxed text-ink-2">{f.detail}</div>
                        </div>
                    </li>
                ))}
                {list.length === 0 && <li className="text-sm text-muted">No issues found.</li>}
            </ul>
        </div>
    )
}

// ---------------------------------------------------------------------------------------
// Simulation
// ---------------------------------------------------------------------------------------

const COHORT_LABEL: Record<Cohort, string> = { creator: 'Creator', sniper: 'Snipers', whale: 'Whale', organic: 'Crowd' }

export function SimulationPanel({ a, initial = 'sniper-rush', runs }: { a: AnalyzedPreset; initial?: string; runs?: Record<string, ScenarioResult> }) {
    const [scenarioId, setScenarioId] = useState(initial)
    const result = useMemo(() => runs?.[scenarioId] ?? simulate(a, scenarioId), [a, scenarioId, runs])
    const q = a.spec.quote
    const scenario = SCENARIOS.find((s) => s.id === scenarioId)!

    return (
        <div>
            <div className="mb-3 flex flex-wrap gap-1.5">
                {SCENARIOS.map((s) => (
                    <button
                        key={s.id}
                        onClick={() => setScenarioId(s.id)}
                        className={cx(
                            'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
                            s.id === scenarioId ? 'border-accent bg-accent-wash text-ink' : 'border-line text-ink-2 hover:border-line-strong hover:text-ink'
                        )}
                    >
                        {s.name}
                    </button>
                ))}
            </div>
            <p className="mb-4 text-[13px] text-muted">
                {scenario.description} Seed {scenario.seed}; trade sizes scale with the raise, so every preset faces the same market.
            </p>

            <div className="mb-4 grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat
                    label="Graduation"
                    value={result.graduated ? `in ${duration(result.graduationSec ?? 0)}` : 'not reached'}
                    sub={result.graduated ? `${result.trades.length} trades` : `${pct((result.timeline.at(-1)?.progress ?? 0) * 100, 0)} of raise`}
                />
                <Stat label="Volume" value={`${num(result.volumeQuote)} ${q}`} sub={`${num(result.volumeQuote / a.analysis.raise, { digits: 1 })}x the raise`} />
                <Stat label="Fees to author" value={`${num(result.fees.partner)} ${q}`} sub={`creator ${num(result.fees.creator)} ${q}`} />
                <SniperStat result={result} quote={q} />
            </div>

            <LineChart
                height={200}
                series={[
                    {
                        id: 'mcap',
                        label: 'Market cap',
                        color: 'var(--s1)',
                        area: true,
                        points: result.timeline.map((p) => ({ x: p.t, y: p.mcap })),
                    },
                ]}
                xFormat={(x) => duration(x)}
                xTooltip={(x) => `${duration(x)} after launch`}
                xLabel="time since launch"
                yFormat={(y) => num(y)}
                markers={result.graduationSec !== null ? [{ x: result.graduationSec, label: 'graduates' }] : []}
            />

            <div className="mt-5 overflow-x-auto">
                <table className="w-full text-[13px]">
                    <thead>
                        <tr className="border-b border-line text-left text-xs text-muted">
                            <th className="py-2 font-medium">Cohort</th>
                            <th className="py-2 text-right font-medium">Wallets</th>
                            <th className="py-2 text-right font-medium">Spent</th>
                            <th className="py-2 text-right font-medium">Fees paid</th>
                            <th className="py-2 text-right font-medium">PnL at graduation</th>
                            <th className="py-2 text-right font-medium">ROI</th>
                        </tr>
                    </thead>
                    <tbody className="tnum">
                        {result.cohorts.map((c) => (
                            <tr key={c.cohort} className="border-b border-line last:border-0">
                                <td className="py-2">{COHORT_LABEL[c.cohort]}</td>
                                <td className="py-2 text-right">{c.actors}</td>
                                <td className="py-2 text-right">{num(c.spentQuote)}</td>
                                <td className="py-2 text-right">{num(c.feesQuote)}</td>
                                <td className="py-2 text-right">{num(c.pnlQuote)}</td>
                                <td className="py-2 text-right font-semibold">{pct(c.roiPct, 0)}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
                <p className="mt-2 text-xs text-muted">
                    Amounts in {q}. PnL marks remaining holdings at the graduation price. Every trade runs through the same fixed-point math as the
                    on-chain program.
                </p>
            </div>

            {result.migration && <MigrationSummary a={a} result={result} />}
        </div>
    )
}

function SniperStat({ result, quote }: { result: ScenarioResult; quote: string }) {
    const sn = result.cohorts.find((c) => c.cohort === 'sniper')
    if (!sn) {
        const crowd = result.cohorts.find((c) => c.cohort === 'organic')
        return <Stat label="Crowd ROI" value={crowd ? pct(crowd.roiPct, 0) : '-'} sub="at graduation price" />
    }
    return <Stat label="Sniper ROI" value={pct(sn.roiPct, 0)} sub={`paid ${num(sn.feesQuote)} ${quote} in fees`} />
}

function MigrationSummary({ a, result }: { a: AnalyzedPreset; result: ScenarioResult }) {
    const m = result.migration!
    const qDec = a.spec.quote === 'SOL' ? 9 : 6
    const toQ = (x: BN) => new Decimal(x.toString()).div(new Decimal(10).pow(qDec)).toNumber()
    const toB = (x: BN) => new Decimal(x.toString()).div(new Decimal(10).pow(a.spec.token.decimals)).toNumber()
    const q = a.spec.quote
    return (
        <div className="mt-5 rounded-xl bg-surface-2 p-4">
            <div className="mb-2 flex items-center gap-2 text-[13px] font-semibold">
                At graduation
                <InfoTip>
                    Predicted from the final pool state using the program's own migration math: graduation fee, the 0.2% protocol liquidity
                    fee, surplus split and LP ownership. Checked against a real DAMM v2 migration in the test suite.
                </InfoTip>
            </div>
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                <Stat label="DAMM v2 pool" value={`${num(toQ(m.quoteToPool))} ${q}`} sub={`+ ${num(toB(m.baseToPool))} tokens`} />
                <Stat label="Graduation fee" value={`${num(toQ(m.migrationFee.total))} ${q}`} sub={`creator ${num(toQ(m.migrationFee.creator))}`} />
                <Stat label="Surplus" value={`${num(toQ(m.surplus.total))} ${q}`} sub="overshoot on the last buy" />
                <Stat label="Opening price" value={`${price(a.analysis.endPrice)} ${q}`} sub="exactly the final curve price" />
            </div>
        </div>
    )
}

export function Panel({ title, hint, right, children, className }: { title: string; hint?: ReactNode; right?: ReactNode; children: ReactNode; className?: string }) {
    return (
        <Card className={className}>
            <SectionTitle hint={hint} right={right}>
                {title}
            </SectionTitle>
            {children}
        </Card>
    )
}
