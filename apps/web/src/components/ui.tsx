import { ButtonHTMLAttributes, ReactNode, useState } from 'react'
import { explorerUrl, Network, Severity } from '@launchproof/core'
import { short } from '../lib/format'

export function cx(...xs: (string | false | null | undefined)[]) {
    return xs.filter(Boolean).join(' ')
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger'
    size?: 'sm' | 'md' | 'lg'
    loading?: boolean
}

export function Button({ variant = 'secondary', size = 'md', loading, className, children, disabled, ...rest }: ButtonProps) {
    return (
        <button
            {...rest}
            disabled={disabled || loading}
            className={cx(
                'inline-flex items-center justify-center gap-2 rounded-[10px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                size === 'sm' && 'h-8 px-3 text-[13px]',
                size === 'md' && 'h-9 px-3.5 text-sm',
                size === 'lg' && 'h-11 px-5 text-[15px]',
                variant === 'primary' && 'bg-accent text-accent-ink hover:bg-accent-hover',
                variant === 'secondary' && 'border border-line-strong bg-surface-2 text-ink hover:bg-surface-3',
                variant === 'ghost' && 'text-ink-2 hover:bg-surface-2 hover:text-ink',
                variant === 'danger' && 'bg-critical text-white hover:opacity-90',
                className
            )}
        >
            {loading && <Spinner />}
            {children}
        </button>
    )
}

export function Spinner({ className }: { className?: string }) {
    return (
        <span
            aria-hidden
            className={cx('inline-block size-4 animate-spin rounded-full border-2 border-current border-t-transparent', className)}
        />
    )
}

export function Card({ children, className, pad = true }: { children: ReactNode; className?: string; pad?: boolean }) {
    return <div className={cx('rounded-2xl border border-line bg-surface', pad && 'p-5', className)}>{children}</div>
}

export function SectionTitle({ children, hint, right }: { children: ReactNode; hint?: ReactNode; right?: ReactNode }) {
    return (
        <div className="mb-3 flex items-end justify-between gap-3">
            <div>
                <h3 className="text-[15px] font-semibold">{children}</h3>
                {hint && <p className="mt-0.5 text-[13px] text-muted">{hint}</p>}
            </div>
            {right}
        </div>
    )
}

export function Field({ label, hint, children, className }: { label: string; hint?: ReactNode; children: ReactNode; className?: string }) {
    return (
        <label className={cx('block', className)}>
            <div className="mb-1.5 flex items-baseline justify-between gap-2">
                <span className="text-[13px] font-medium text-ink-2">{label}</span>
                {hint && <span className="text-xs text-muted">{hint}</span>}
            </div>
            {children}
        </label>
    )
}

const inputCls =
    'h-9 w-full rounded-[10px] border border-line-strong bg-surface-2 px-3 text-sm text-ink outline-none placeholder:text-muted focus:border-accent'

export function TextInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
    return <input {...props} className={cx(inputCls, props.className)} />
}

export function TextArea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
    return <textarea {...props} className={cx(inputCls, 'h-auto min-h-20 py-2 leading-snug', props.className)} />
}

export function NumberInput({
    value,
    onChange,
    suffix,
    min,
    max,
    step,
    className,
}: {
    value: number
    onChange: (v: number) => void
    suffix?: string
    min?: number
    max?: number
    step?: number
    className?: string
}) {
    const [draft, setDraft] = useState<string | null>(null)
    return (
        <div className={cx('relative', className)}>
            <input
                type="number"
                inputMode="decimal"
                className={cx(inputCls, 'tnum pr-14')}
                // show at most 6 significant digits; the full-precision value stays in state
                value={draft ?? String(Number.isFinite(value) ? Number(value.toPrecision(6)) : value)}
                min={min}
                max={max}
                step={step ?? 'any'}
                onChange={(e) => {
                    setDraft(e.target.value)
                    const v = Number(e.target.value)
                    if (e.target.value !== '' && Number.isFinite(v)) onChange(v)
                }}
                onBlur={() => setDraft(null)}
            />
            {suffix && (
                <span className="pointer-events-none absolute top-1/2 right-3 -translate-y-1/2 text-xs text-muted">{suffix}</span>
            )}
        </div>
    )
}

export function Slider({
    value,
    onChange,
    min,
    max,
    step = 1,
    format,
}: {
    value: number
    onChange: (v: number) => void
    min: number
    max: number
    step?: number
    format?: (v: number) => string
}) {
    return (
        <div className="flex items-center gap-3">
            <input
                type="range"
                className="h-1.5 flex-1 cursor-pointer"
                value={value}
                min={min}
                max={max}
                step={step}
                onChange={(e) => onChange(Number(e.target.value))}
            />
            <span className="tnum w-16 text-right text-sm text-ink">{format ? format(value) : value}</span>
        </div>
    )
}

export function Toggle({ checked, onChange, label, hint }: { checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string }) {
    return (
        <button
            type="button"
            role="switch"
            aria-checked={checked}
            onClick={() => onChange(!checked)}
            className="flex w-full items-start gap-3 rounded-[10px] text-left"
        >
            <span
                className={cx(
                    'relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors',
                    checked ? 'bg-accent' : 'bg-surface-3'
                )}
            >
                <span
                    className={cx(
                        'absolute top-0.5 size-4 rounded-full bg-white shadow transition-transform',
                        checked ? 'translate-x-4.5' : 'translate-x-0.5'
                    )}
                />
            </span>
            <span>
                <span className="block text-[13px] font-medium text-ink">{label}</span>
                {hint && <span className="block text-xs text-muted">{hint}</span>}
            </span>
        </button>
    )
}

export function Segmented<T extends string>({
    value,
    onChange,
    options,
    size = 'md',
}: {
    value: T
    onChange: (v: T) => void
    options: { value: T; label: ReactNode }[]
    size?: 'sm' | 'md'
}) {
    return (
        <div className="inline-flex rounded-[10px] border border-line bg-surface-2 p-0.5">
            {options.map((o) => (
                <button
                    key={o.value}
                    type="button"
                    onClick={() => onChange(o.value)}
                    className={cx(
                        'rounded-[8px] font-medium transition-colors',
                        size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-[13px]',
                        value === o.value ? 'bg-surface text-ink shadow-sm' : 'text-muted hover:text-ink'
                    )}
                >
                    {o.label}
                </button>
            ))}
        </div>
    )
}

export function Select<T extends string>({
    value,
    onChange,
    options,
}: {
    value: T
    onChange: (v: T) => void
    options: { value: T; label: string }[]
}) {
    return (
        <select className={cx(inputCls, 'cursor-pointer')} value={value} onChange={(e) => onChange(e.target.value as T)}>
            {options.map((o) => (
                <option key={o.value} value={o.value}>
                    {o.label}
                </option>
            ))}
        </select>
    )
}

export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: 'neutral' | 'accent' }) {
    return (
        <span
            className={cx(
                'inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium',
                tone === 'neutral' ? 'bg-surface-2 text-ink-2' : 'bg-accent-wash text-accent'
            )}
        >
            {children}
        </span>
    )
}

const SEVERITY_COLOR: Record<Severity, string> = {
    critical: 'var(--critical)',
    warning: 'var(--warning)',
    info: 'var(--s1)',
    good: 'var(--good)',
}

/** Severity never relies on color alone: a shaped icon and the label travel with it. */
export function SeverityIcon({ severity }: { severity: Severity }) {
    const c = SEVERITY_COLOR[severity]
    return (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-label={severity} className="shrink-0">
            {severity === 'critical' && (
                <>
                    <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill={c} />
                    <path d="M5.5 5.5l5 5M10.5 5.5l-5 5" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
                </>
            )}
            {severity === 'warning' && (
                <>
                    <path d="M8 1.8l6.6 11.6H1.4z" fill={c} />
                    <path d="M8 6v3.6" stroke="#1a1a19" strokeWidth="1.8" strokeLinecap="round" />
                    <circle cx="8" cy="11.6" r="1" fill="#1a1a19" />
                </>
            )}
            {severity === 'info' && (
                <>
                    <circle cx="8" cy="8" r="6.5" fill={c} />
                    <path d="M8 7.2v4" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
                    <circle cx="8" cy="4.8" r="1" fill="white" />
                </>
            )}
            {severity === 'good' && (
                <>
                    <circle cx="8" cy="8" r="6.5" fill={c} />
                    <path d="M5 8.2l2 2 4-4.2" stroke="white" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </>
            )}
        </svg>
    )
}

export function GradeBadge({ grade, score, size = 'md' }: { grade: string; score: number; size?: 'sm' | 'md' | 'lg' }) {
    const color =
        grade === 'A' ? 'var(--good)' : grade === 'B' ? 'var(--s3)' : grade === 'C' ? 'var(--warning)' : grade === 'D' ? 'var(--serious)' : 'var(--critical)'
    const dim = size === 'lg' ? 'size-14 text-2xl' : size === 'md' ? 'size-10 text-lg' : 'size-7 text-sm'
    return (
        <div className="flex items-center gap-2" title={`Launch health ${score}/100`}>
            <div
                className={cx('grid place-items-center rounded-xl border-2 font-bold', dim)}
                style={{ borderColor: color, color: 'var(--ink)' }}
            >
                {grade}
            </div>
            {size !== 'sm' && (
                <div className="leading-tight">
                    <div className="tnum text-sm font-semibold">{score}/100</div>
                    <div className="text-xs text-muted">launch health</div>
                </div>
            )}
        </div>
    )
}

export function Stat({ label, value, sub, className }: { label: string; value: ReactNode; sub?: ReactNode; className?: string }) {
    return (
        <div className={cx('min-w-0', className)}>
            <div className="truncate text-xs text-muted">{label}</div>
            <div className="mt-0.5 truncate text-lg font-semibold">{value}</div>
            {sub && <div className="truncate text-xs text-ink-2">{sub}</div>}
        </div>
    )
}

export function Progress({ value, className }: { value: number; className?: string }) {
    const v = Math.max(0, Math.min(1, value))
    return (
        <div className={cx('h-2 w-full overflow-hidden rounded-full bg-surface-3', className)}>
            <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${v * 100}%` }} />
        </div>
    )
}

export function Address({ value, network, kind = 'address', chars = 4 }: { value: string; network: Network; kind?: 'address' | 'tx'; chars?: number }) {
    const [copied, setCopied] = useState(false)
    return (
        <span className="inline-flex items-center gap-1.5 font-mono text-[13px]">
            <a className="text-ink-2 hover:text-accent hover:underline" href={explorerUrl(network, kind, value)} target="_blank" rel="noreferrer">
                {short(value, chars)}
            </a>
            <button
                type="button"
                className="text-muted hover:text-ink"
                title="Copy"
                onClick={() => {
                    navigator.clipboard?.writeText(value).then(() => {
                        setCopied(true)
                        setTimeout(() => setCopied(false), 1200)
                    })
                }}
            >
                {copied ? (
                    <svg width="13" height="13" viewBox="0 0 16 16"><path d="M3 8.5l3 3 7-7" stroke="currentColor" strokeWidth="2" fill="none" /></svg>
                ) : (
                    <svg width="13" height="13" viewBox="0 0 16 16"><rect x="5" y="5" width="8.5" height="8.5" rx="2" stroke="currentColor" strokeWidth="1.5" fill="none" /><path d="M10.5 3.5V3a1.5 1.5 0 00-1.5-1.5H3.5A1.5 1.5 0 002 3v5.5A1.5 1.5 0 003.5 10H4" stroke="currentColor" strokeWidth="1.5" fill="none" /></svg>
                )}
            </button>
        </span>
    )
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
    return (
        <div className="rounded-2xl border border-dashed border-line-strong px-6 py-10 text-center">
            <div className="text-sm font-semibold">{title}</div>
            {children && <div className="mx-auto mt-1 max-w-md text-[13px] text-muted">{children}</div>}
        </div>
    )
}

export function Skeleton({ className }: { className?: string }) {
    return <div className={cx('animate-pulse rounded-lg bg-surface-2', className)} />
}

export function InfoTip({ children }: { children: ReactNode }) {
    return (
        <span className="group relative inline-flex align-middle">
            <span className="grid size-4 cursor-help place-items-center rounded-full border border-line-strong text-[10px] text-muted">?</span>
            <span className="pointer-events-none absolute bottom-full left-1/2 z-30 mb-2 hidden w-64 -translate-x-1/2 rounded-lg border border-line bg-surface p-2.5 text-xs leading-snug text-ink-2 shadow-lg group-hover:block">
                {children}
            </span>
        </span>
    )
}
