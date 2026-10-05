import { useRef } from 'react'
import { CurveKind, CurveShape } from '@curvesmith/core'
import { cx, NumberInput } from '../ui'
import { num } from '../../lib/format'

export const SHAPES: Array<{ kind: CurveKind; label: string; hint: string; glyph: string }> = [
    { kind: 'constant-product', label: 'Constant product', hint: 'One x*y=k segment, pump-style', glyph: 'M2 22 C 14 21, 20 16, 30 2' },
    { kind: 'linear', label: 'Linear', hint: 'Price rises evenly per token sold', glyph: 'M2 22 L 30 2' },
    { kind: 'exponential', label: 'Exponential', hint: 'Same % step for every slice', glyph: 'M2 22 C 18 22, 26 14, 30 2' },
    { kind: 'power', label: 'Power', hint: 'Front- or back-loaded growth', glyph: 'M2 22 C 4 10, 14 4, 30 2' },
    { kind: 'sigmoid', label: 'S-curve', hint: 'Slow, fast, then calm', glyph: 'M2 22 C 14 22, 18 2, 30 2' },
    { kind: 'flat', label: 'Flat', hint: 'Fixed-price sale (NAV, RWA)', glyph: 'M2 13 L 30 11' },
    { kind: 'tranches', label: 'Tranches', hint: 'Stepped rounds, IPO-style', glyph: 'M2 20 H 10 V 14 H 18 V 8 H 30' },
    { kind: 'custom', label: 'Freehand', hint: 'Drag your own price path', glyph: 'M2 22 L 9 18 L 16 19 L 23 9 L 30 3' },
]

export function defaultShape(kind: CurveKind): CurveShape {
    switch (kind) {
        case 'power':
            return { kind, exponent: 0.5 }
        case 'sigmoid':
            return { kind, steepness: 9, midpoint: 0.5 }
        case 'flat':
            return { kind, bandBps: 100 }
        case 'tranches':
            return {
                kind,
                bandBps: 50,
                tranches: [
                    { priceMultiple: 1, share: 0.4 },
                    { priceMultiple: 1.5, share: 0.35 },
                    { priceMultiple: 2.25, share: 0.25 },
                ],
            }
        case 'custom':
            return {
                kind,
                points: Array.from({ length: 9 }, (_, i) => ({ x: i / 8, multiple: Math.round(Math.pow(12, i / 8) * 100) / 100 })),
            }
        default:
            return { kind } as CurveShape
    }
}

export function ShapePicker({ value, onChange }: { value: CurveKind; onChange: (k: CurveKind) => void }) {
    return (
        <div className="grid grid-cols-4 gap-2">
            {SHAPES.map((s) => (
                <button
                    key={s.kind}
                    type="button"
                    title={s.hint}
                    onClick={() => onChange(s.kind)}
                    className={cx(
                        'flex flex-col items-center gap-1 rounded-xl border px-1 py-2 text-[11px] font-medium transition-colors',
                        value === s.kind ? 'border-accent bg-accent-wash text-ink' : 'border-line text-ink-2 hover:border-line-strong hover:text-ink'
                    )}
                >
                    <svg width="32" height="24" viewBox="0 0 32 24" aria-hidden>
                        <path d={s.glyph} fill="none" stroke={value === s.kind ? 'var(--accent)' : 'currentColor'} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <span className="text-center leading-tight">{s.label}</span>
                </button>
            ))}
        </div>
    )
}

/**
 * Freehand curve: drag the handles to set the price multiple (log scale) at evenly spaced
 * points of the sale. Handles are kept non-decreasing because a bonding curve can't go down.
 */
export function FreehandEditor({ points, onChange }: { points: Array<{ x: number; multiple: number }>; onChange: (p: Array<{ x: number; multiple: number }>) => void }) {
    const svg = useRef<SVGSVGElement>(null)
    const W = 320
    const H = 160
    const pad = 14
    const maxM = 1000
    const toY = (m: number) => pad + (1 - Math.log10(Math.max(1, m)) / Math.log10(maxM)) * (H - 2 * pad)
    const toM = (y: number) => Math.pow(10, (1 - (y - pad) / (H - 2 * pad)) * Math.log10(maxM))
    const toX = (x: number) => pad + x * (W - 2 * pad)

    const drag = (i: number) => (e: React.PointerEvent) => {
        if (i === 0) return
        const el = svg.current!
        ;(e.target as Element).setPointerCapture(e.pointerId)
        const move = (ev: PointerEvent) => {
            const rect = el.getBoundingClientRect()
            const y = ((ev.clientY - rect.top) / rect.height) * H
            const raw = Math.min(maxM, Math.max(1, toM(y)))
            const next = points.map((p) => ({ ...p }))
            next[i].multiple = Math.round(raw * 100) / 100
            for (let j = i + 1; j < next.length; j++) next[j].multiple = Math.max(next[j].multiple, next[j - 1].multiple * 1.001)
            for (let j = i - 1; j >= 1; j--) next[j].multiple = Math.min(next[j].multiple, next[j + 1].multiple / 1.001)
            onChange(next)
        }
        const up = () => {
            window.removeEventListener('pointermove', move)
            window.removeEventListener('pointerup', up)
        }
        window.addEventListener('pointermove', move)
        window.addEventListener('pointerup', up)
    }

    const d = points.map((p, i) => `${i ? 'L' : 'M'}${toX(p.x)},${toY(p.multiple)}`).join('')
    return (
        <div>
            <svg ref={svg} viewBox={`0 0 ${W} ${H}`} className="w-full touch-none rounded-xl bg-surface-2" style={{ height: H }}>
                {[1, 10, 100, 1000].map((m) => (
                    <g key={m}>
                        <line x1={pad} x2={W - pad} y1={toY(m)} y2={toY(m)} stroke="var(--grid)" />
                        <text x={W - pad} y={toY(m) - 3} fontSize="9" textAnchor="end" fill="var(--muted)">
                            {m}x
                        </text>
                    </g>
                ))}
                <path d={d} fill="none" stroke="var(--s1)" strokeWidth="2" strokeLinejoin="round" />
                {points.map((p, i) => (
                    <g key={i} onPointerDown={drag(i)} style={{ cursor: i === 0 ? 'default' : 'ns-resize' }}>
                        <circle cx={toX(p.x)} cy={toY(p.multiple)} r="12" fill="transparent" />
                        <circle cx={toX(p.x)} cy={toY(p.multiple)} r="6" fill="var(--surface)" />
                        <circle cx={toX(p.x)} cy={toY(p.multiple)} r="4.5" fill={i === 0 ? 'var(--muted)' : 'var(--s1)'} />
                    </g>
                ))}
            </svg>
            <p className="mt-1.5 text-xs text-muted">
                Drag points to set the price as a multiple of the start price across the sale. Ends at {num(points[points.length - 1].multiple, { digits: 1 })}x.
            </p>
        </div>
    )
}

export function TrancheEditor({
    shape,
    onChange,
}: {
    shape: Extract<CurveShape, { kind: 'tranches' }>
    onChange: (s: Extract<CurveShape, { kind: 'tranches' }>) => void
}) {
    const total = shape.tranches.reduce((s, t) => s + t.share, 0)
    const set = (i: number, patch: Partial<{ priceMultiple: number; share: number }>) =>
        onChange({ ...shape, tranches: shape.tranches.map((t, j) => (j === i ? { ...t, ...patch } : t)) })
    return (
        <div className="space-y-2">
            <div className="grid grid-cols-[24px_1fr_1fr_28px] items-center gap-2 text-xs text-muted">
                <span>#</span>
                <span>Price vs tranche 1</span>
                <span>Share of sale</span>
                <span />
            </div>
            {shape.tranches.map((t, i) => (
                <div key={i} className="grid grid-cols-[24px_1fr_1fr_28px] items-center gap-2">
                    <span className="text-xs text-muted">{i + 1}</span>
                    <NumberInput value={t.priceMultiple} suffix="x" step={0.05} onChange={(v) => set(i, { priceMultiple: Math.max(i === 0 ? 1 : 0.01, v) })} />
                    <NumberInput value={Math.round((t.share / total) * 1000) / 10} suffix="%" step={1} onChange={(v) => set(i, { share: Math.max(0.01, v / 100) })} />
                    <button
                        type="button"
                        disabled={shape.tranches.length <= 2}
                        onClick={() => onChange({ ...shape, tranches: shape.tranches.filter((_, j) => j !== i) })}
                        className="text-muted hover:text-critical disabled:opacity-30"
                        aria-label="Remove tranche"
                    >
                        x
                    </button>
                </div>
            ))}
            <button
                type="button"
                disabled={shape.tranches.length >= 8}
                onClick={() => {
                    const last = shape.tranches[shape.tranches.length - 1]
                    onChange({ ...shape, tranches: [...shape.tranches, { priceMultiple: Math.round(last.priceMultiple * 1.3 * 100) / 100, share: last.share }] })
                }}
                className="text-[13px] font-medium text-accent disabled:opacity-40"
            >
                + Add tranche (max 8: each takes two of DBC's 16 curve segments)
            </button>
        </div>
    )
}
