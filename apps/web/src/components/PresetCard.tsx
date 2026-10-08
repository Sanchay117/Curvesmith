import { Link } from 'react-router-dom'
import { Evaluation, PresetCategory } from '@launchproof/core'
import { Sparkline } from './charts/LineChart'
import { Badge, GradeBadge, Skeleton } from './ui'
import { bps, num } from '../lib/format'

export const CATEGORY_LABEL: Record<PresetCategory, string> = {
    meme: 'Meme',
    community: 'Community',
    rwa: 'RWA',
    equity: 'Equity',
    ai: 'AI agent',
    creator: 'Creator',
    experimental: 'Experimental',
}

export function PresetCard({
    href,
    name,
    tagline,
    category,
    evaluation,
    footer,
}: {
    href: string
    name: string
    tagline: string
    category: PresetCategory
    evaluation: Evaluation | Error | null
    footer?: React.ReactNode
}) {
    const ev = evaluation instanceof Error ? null : evaluation
    const x = ev?.analyzed.analysis
    return (
        <Link
            to={href}
            className="group flex flex-col rounded-2xl border border-line bg-surface p-4 transition-colors hover:border-line-strong"
        >
            <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                    <div className="mb-1 flex items-center gap-2">
                        <Badge>{CATEGORY_LABEL[category] ?? category}</Badge>
                        {ev && <span className="text-[11px] text-muted">{ev.analyzed.spec.pricing.shape.kind.replace('-', ' ')} curve</span>}
                    </div>
                    <div className="truncate text-[15px] font-semibold group-hover:text-accent">{name}</div>
                    <div className="mt-0.5 line-clamp-2 min-h-[2.5em] text-[13px] leading-snug text-ink-2">{tagline}</div>
                </div>
                {ev ? <GradeBadge grade={ev.lint.grade} score={ev.lint.score} size="sm" /> : <Skeleton className="size-7" />}
            </div>
            <div className="mt-3">
                {ev ? (
                    <Sparkline
                        points={ev.analyzed.curve.map((c) => ({ x: c.sold, y: c.price }))}
                        log={ev.analyzed.analysis.maxMultiple > 30}
                    />
                ) : evaluation instanceof Error ? (
                    <div className="grid h-11 place-items-center text-xs text-critical">{evaluation.message.slice(0, 80)}</div>
                ) : (
                    <Skeleton className="h-11" />
                )}
            </div>
            {x && (
                <dl className="mt-3 grid grid-cols-3 gap-2 border-t border-line pt-3 text-xs">
                    <div>
                        <dt className="text-muted">Raise</dt>
                        <dd className="tnum mt-0.5 font-semibold">
                            {num(x.raise)} {x.quoteSymbol}
                        </dd>
                    </div>
                    <div>
                        <dt className="text-muted">Mcap range</dt>
                        <dd className="tnum mt-0.5 font-semibold">{num(x.maxMultiple, { digits: 1 })}x</dd>
                    </div>
                    <div>
                        <dt className="text-muted">Fee</dt>
                        <dd className="tnum mt-0.5 font-semibold">
                            {x.fee.startBps === x.fee.endBps ? bps(x.fee.startBps) : `${bps(x.fee.startBps)} to ${bps(x.fee.endBps)}`}
                        </dd>
                    </div>
                </dl>
            )}
            {footer && <div className="mt-3 border-t border-line pt-3">{footer}</div>}
        </Link>
    )
}
