import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { cx } from './ui'
import { prefersReducedMotion } from './motion'

type Severity = 'critical' | 'warning' | 'info' | 'good'

/** Real mainnet configs and the findings the census recorded for them (census-mainnet-beta.json). */
const EXAMPLES: Array<{ address: string; launches: string; quote: string; curve: string; findings: Array<{ text: string; severity: Severity }>; verdict: string }> = [
    {
        address: '2bFH5q216w51UopEZP359NGGSUUeCwmycoBzP8Jc83at',
        launches: '1,841 tokens launched',
        quote: 'SOL',
        curve: 'M24 196 C 120 190, 200 168, 270 120 S 380 44, 436 30',
        findings: [
            { text: '90% residual supply', severity: 'critical' },
            { text: '89% of LP unlocked', severity: 'warning' },
            { text: 'No sniper fee decay', severity: 'info' },
        ],
        verdict: '2 terms to read first',
    },
    {
        address: '38RRrtvAbAYnmCDjym31nvw5MYQGi3LQJQ6Gp6RbT7DU',
        launches: '59,803 tokens launched',
        quote: 'SOL',
        curve: 'M24 112 L 436 108',
        findings: [
            { text: '100% of LP unlocked', severity: 'warning' },
            { text: 'Flat price, 1x range', severity: 'info' },
        ],
        verdict: '1 term to read first',
    },
    {
        address: 'FbKf76ucsQssF7XZBuzScdJfugtsSKwZFYztKsMEhWZM',
        launches: '175,620 tokens launched',
        quote: 'USDC',
        curve: 'M24 200 C 180 198, 300 180, 360 120 S 420 40, 436 26',
        findings: [
            { text: 'All LP locked forever', severity: 'good' },
            { text: 'No sniper fee decay', severity: 'info' },
        ],
        verdict: 'No flagged terms',
    },
]

const DOT: Record<Severity, string> = {
    critical: 'var(--critical)',
    warning: 'var(--serious)',
    info: 'var(--s1)',
    good: 'var(--good)',
}

/**
 * The home page's hero: a live-looking audit that draws a config's curve, scans it, and pops
 * the findings in one by one, cycling through three real configs. Clicking opens the real audit.
 */
export function HeroAudit() {
    const [i, setI] = useState(0)
    useEffect(() => {
        if (prefersReducedMotion()) return
        const id = setInterval(() => setI((n) => (n + 1) % EXAMPLES.length), 7000)
        return () => clearInterval(id)
    }, [])
    const ex = EXAMPLES[i]
    const flagged = ex.findings.some((f) => f.severity === 'critical' || f.severity === 'warning')
    return (
        <Link
            to={`/audit/${ex.address}?network=mainnet-beta`}
            aria-label={`Open the audit of config ${ex.address}`}
            className="lp-lift group relative block overflow-hidden rounded-3xl border border-line bg-surface/80 p-5 backdrop-blur"
        >
            <div key={ex.address}>
                <div className="flex items-center justify-between gap-3 text-xs">
                    <div className="flex items-center gap-2 font-mono text-ink-2">
                        <span className="lp-breathe size-2 rounded-full bg-accent" />
                        {ex.address.slice(0, 4)}...{ex.address.slice(-4)}
                        <span className="text-muted">· mainnet · {ex.quote}</span>
                    </div>
                    <span className="text-muted">{ex.launches}</span>
                </div>

                <div className="relative mt-4">
                    <svg viewBox="0 0 460 220" className="w-full" aria-hidden>
                        <defs>
                            <linearGradient id="hero-area" x1="0" y1="0" x2="0" y2="1">
                                <stop offset="0" stopColor="var(--accent)" stopOpacity="0.28" />
                                <stop offset="1" stopColor="var(--accent)" stopOpacity="0" />
                            </linearGradient>
                            <linearGradient id="hero-scan" x1="0" y1="0" x2="1" y2="0">
                                <stop offset="0" stopColor="var(--accent)" stopOpacity="0" />
                                <stop offset="1" stopColor="var(--accent)" stopOpacity="0.35" />
                            </linearGradient>
                        </defs>
                        {[40, 90, 140, 190].map((y) => (
                            <line key={y} x1="24" x2="436" y1={y} y2={y} stroke="var(--grid)" />
                        ))}
                        <path d={`${ex.curve} L 436 210 L 24 210 Z`} fill="url(#hero-area)" className="lp-pop" style={{ animationDelay: '900ms' }} />
                        <path d={ex.curve} pathLength={1} fill="none" stroke="var(--accent)" strokeWidth="3.5" strokeLinecap="round" className="lp-draw" />
                        <rect className="lp-scan" x="0" y="10" width="46" height="200" fill="url(#hero-scan)" />
                    </svg>
                </div>

                <div className="mt-2 flex flex-wrap gap-2">
                    {ex.findings.map((f, n) => (
                        <span
                            key={f.text}
                            className="lp-pop inline-flex items-center gap-2 rounded-full border border-line bg-surface-2 px-3 py-1.5 text-[13px] font-medium"
                            style={{ animationDelay: `${1300 + n * 350}ms` }}
                        >
                            <span className="size-2 rounded-full" style={{ background: DOT[f.severity] }} />
                            {f.text}
                        </span>
                    ))}
                </div>

                <div
                    className="lp-pop mt-4 flex items-center justify-between border-t border-line pt-3"
                    style={{ animationDelay: `${1400 + ex.findings.length * 350}ms` }}
                >
                    <span className={cx('text-sm font-semibold', flagged ? 'text-serious' : 'text-good')}>{ex.verdict}</span>
                    <span className="text-xs font-medium text-accent group-hover:underline">Open full audit →</span>
                </div>
            </div>

            <div className="absolute top-1/2 right-3 flex flex-col gap-1.5" aria-hidden>
                {EXAMPLES.map((e, n) => (
                    <span key={e.address} className={cx('w-1.5 rounded-full transition-all duration-500', n === i ? 'h-5 bg-accent' : 'h-1.5 bg-surface-3')} />
                ))}
            </div>
        </Link>
    )
}

/** One-click real examples under the audit box, so nobody has to go find an address. */
export const AUDIT_EXAMPLES = EXAMPLES.map((e) => ({ address: e.address, label: e.launches.replace(' tokens launched', ' launches') }))
