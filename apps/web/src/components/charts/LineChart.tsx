import { ReactNode, useEffect, useMemo, useRef, useState } from 'react'

export interface Series {
    id: string
    label: string
    /** CSS color, normally a palette role like var(--s1). */
    color: string
    points: Array<{ x: number; y: number }>
    area?: boolean
    dashed?: boolean
    /** Draw as a step function (value holds until the next point). */
    step?: boolean
}

export interface Marker {
    x: number
    label?: string
}

export interface Dot {
    x: number
    y: number
    label: string
    color?: string
}

interface Props {
    series: Series[]
    height?: number
    xFormat: (x: number) => string
    yFormat: (y: number) => string
    /** Header line of the tooltip; defaults to xFormat. */
    xTooltip?: (x: number) => string
    xLabel?: string
    yLog?: boolean
    yMin?: number
    markers?: Marker[]
    dots?: Dot[]
    empty?: ReactNode
}

const M = { top: 14, right: 18, bottom: 30, left: 60 }

function niceStep(range: number, target: number) {
    const raw = range / Math.max(1, target)
    const mag = Math.pow(10, Math.floor(Math.log10(raw)))
    const norm = raw / mag
    const nice = norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10
    return nice * mag
}

function linearTicks(min: number, max: number, target = 5): number[] {
    if (!(max > min)) return [min]
    const step = niceStep(max - min, target)
    const start = Math.ceil(min / step) * step
    const out: number[] = []
    for (let v = start; v <= max + step * 1e-9; v += step) out.push(Number(v.toPrecision(12)))
    return out
}

function logTicks(min: number, max: number): number[] {
    const out: number[] = []
    const lo = Math.floor(Math.log10(min))
    const hi = Math.ceil(Math.log10(max))
    const span = hi - lo
    for (let e = lo; e <= hi; e++) {
        for (const m of span > 4 ? [1] : span > 2 ? [1, 3] : [1, 2, 5]) {
            const v = m * Math.pow(10, e)
            if (v >= min * 0.999 && v <= max * 1.001) out.push(v)
        }
    }
    return out
}

function nearestIndex(points: Array<{ x: number }>, x: number): number {
    let lo = 0
    let hi = points.length - 1
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1
        if (points[mid].x < x) lo = mid
        else hi = mid
    }
    return Math.abs(points[lo].x - x) <= Math.abs(points[hi].x - x) ? lo : hi
}

/** Value of a series at x: step series hold the last value, others take the nearest point. */
function valueAt(s: Series, x: number): { x: number; y: number } | null {
    if (s.points.length === 0) return null
    if (x < s.points[0].x - 1e-12 || x > s.points[s.points.length - 1].x + 1e-12) return null
    if (s.step) {
        let i = nearestIndex(s.points, x)
        if (s.points[i].x > x && i > 0) i--
        return { x, y: s.points[i].y }
    }
    return s.points[nearestIndex(s.points, x)]
}

export function LineChart({ series, height = 260, xFormat, yFormat, xTooltip, xLabel, yLog, yMin, markers = [], dots = [], empty }: Props) {
    // A callback ref (not useRef) so the observer re-attaches if the container element is
    // replaced, e.g. when the chart goes from its empty state to having data.
    const [wrapEl, setWrapEl] = useState<HTMLDivElement | null>(null)
    const wrap = useRef<HTMLDivElement | null>(null)
    wrap.current = wrapEl
    const [width, setWidth] = useState(600)
    const [hoverX, setHoverX] = useState<number | null>(null)

    useEffect(() => {
        if (!wrapEl) return
        const measure = (w: number) => w > 0 && setWidth(Math.max(240, Math.round(w)))
        measure(wrapEl.getBoundingClientRect().width)
        const ro = new ResizeObserver((entries) => measure(entries[0].contentRect.width))
        ro.observe(wrapEl)
        return () => ro.disconnect()
    }, [wrapEl])

    const all = series.flatMap((s) => s.points)
    const geom = useMemo(() => {
        if (all.length === 0) return null
        const xMin = Math.min(...all.map((p) => p.x), ...markers.map((m) => m.x))
        let xMax = Math.max(...all.map((p) => p.x), ...markers.map((m) => m.x))
        if (xMax === xMin) xMax = xMin + 1
        const ys = all.map((p) => p.y).filter((y) => (yLog ? y > 0 : Number.isFinite(y)))
        let yLo = Math.min(...ys, ...(yMin !== undefined ? [yMin] : []))
        let yHi = Math.max(...ys)
        if (yLog) {
            yLo = yLo / 1.15
            yHi = yHi * 1.15
        } else {
            const pad = (yHi - yLo) * 0.08 || Math.abs(yHi) * 0.1 || 1
            yHi += pad
            yLo = yMin !== undefined ? yMin : Math.max(yLo - pad, yLo >= 0 ? 0 : -Infinity)
        }
        const iw = width - M.left - M.right
        const ih = height - M.top - M.bottom
        const sx = (x: number) => M.left + ((x - xMin) / (xMax - xMin)) * iw
        const sy = yLog
            ? (y: number) => M.top + ih - ((Math.log10(Math.max(y, yLo)) - Math.log10(yLo)) / (Math.log10(yHi) - Math.log10(yLo))) * ih
            : (y: number) => M.top + ih - ((y - yLo) / (yHi - yLo)) * ih
        const invX = (px: number) => xMin + ((px - M.left) / iw) * (xMax - xMin)
        const yTicks = yLog ? logTicks(yLo, yHi) : linearTicks(yLo, yHi, 4)
        const xTicks = linearTicks(xMin, xMax, Math.max(2, Math.floor(iw / 110)))
        return { xMin, xMax, yLo, yHi, iw, ih, sx, sy, invX, yTicks, xTicks }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [series, width, height, yLog, yMin, markers])

    if (!geom) return <div ref={setWrapEl} style={{ height }} className="grid place-items-center text-sm text-muted">{empty ?? 'No data'}</div>

    const { sx, sy, iw, ih, invX, yTicks, xTicks } = geom
    const pathOf = (s: Series) => {
        let d = ''
        s.points.forEach((p, i) => {
            const x = sx(p.x)
            const y = sy(p.y)
            if (i === 0) d += `M${x},${y}`
            else if (s.step) d += `H${x}V${y}`
            else d += `L${x},${y}`
        })
        return d
    }
    const areaOf = (s: Series) => {
        const base = M.top + ih
        const first = s.points[0]
        const last = s.points[s.points.length - 1]
        return `${pathOf(s)}L${sx(last.x)},${base}L${sx(first.x)},${base}Z`
    }

    const hover = hoverX === null ? null : series.map((s) => ({ s, p: valueAt(s, hoverX) })).filter((h) => h.p)
    const hoverPx = hoverX === null ? null : sx(hover?.find((h) => h.p)?.p?.x ?? hoverX)

    const move = (clientX: number) => {
        const rect = wrap.current!.getBoundingClientRect()
        const px = clientX - rect.left
        if (px < M.left || px > M.left + iw) return setHoverX(null)
        const x = invX(px)
        // snap to the nearest data x of the densest series
        const dense = series.reduce((a, b) => (b.points.length > a.points.length ? b : a), series[0])
        setHoverX(dense.points.length ? dense.points[nearestIndex(dense.points, x)].x : x)
    }

    return (
        <div>
            {series.length > 1 && (
                <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
                    {series.map((s) => (
                        <span key={s.id} className="inline-flex items-center gap-1.5">
                            <svg width="16" height="8" aria-hidden>
                                <line x1="0" y1="4" x2="16" y2="4" stroke={s.color} strokeWidth="2" strokeDasharray={s.dashed ? '4 3' : undefined} />
                            </svg>
                            {s.label}
                        </span>
                    ))}
                </div>
            )}
            <div ref={setWrapEl} className="relative w-full min-w-0 select-none overflow-hidden" style={{ height }}>
                <svg
                    width="100%"
                    height={height}
                    viewBox={`0 0 ${width} ${height}`}
                    preserveAspectRatio="none"
                    role="img"
                    tabIndex={0}
                    aria-label={series.map((s) => s.label).join(', ')}
                    onPointerMove={(e) => move(e.clientX)}
                    onPointerLeave={() => setHoverX(null)}
                    onKeyDown={(e) => {
                        const dense = series[0]
                        if (!dense?.points.length) return
                        const i = hoverX === null ? 0 : nearestIndex(dense.points, hoverX)
                        if (e.key === 'ArrowRight') setHoverX(dense.points[Math.min(dense.points.length - 1, i + 1)].x)
                        if (e.key === 'ArrowLeft') setHoverX(dense.points[Math.max(0, i - 1)].x)
                        if (e.key === 'Escape') setHoverX(null)
                    }}
                    className="outline-none"
                >
                    {/* grid + y axis */}
                    {yTicks.map((t) => (
                        <g key={`y${t}`}>
                            <line x1={M.left} x2={M.left + iw} y1={sy(t)} y2={sy(t)} stroke="var(--grid)" strokeWidth="1" />
                            <text x={M.left - 8} y={sy(t)} dy="0.32em" textAnchor="end" fontSize="11" fill="var(--muted)" className="tnum">
                                {yFormat(t)}
                            </text>
                        </g>
                    ))}
                    <line x1={M.left} x2={M.left + iw} y1={M.top + ih} y2={M.top + ih} stroke="var(--axis)" strokeWidth="1" />
                    {xTicks.map((t) => (
                        <text key={`x${t}`} x={sx(t)} y={M.top + ih + 18} textAnchor="middle" fontSize="11" fill="var(--muted)" className="tnum">
                            {xFormat(t)}
                        </text>
                    ))}
                    {xLabel && (
                        <text x={M.left + iw} y={height - 2} textAnchor="end" fontSize="10.5" fill="var(--muted)">
                            {xLabel}
                        </text>
                    )}

                    {/* reference markers */}
                    {markers.map((m, i) => (
                        <g key={`m${i}`}>
                            <line x1={sx(m.x)} x2={sx(m.x)} y1={M.top} y2={M.top + ih} stroke="var(--axis)" strokeWidth="1" />
                            {m.label && (
                                <text x={sx(m.x) - 4} y={M.top + 10} textAnchor="end" fontSize="10.5" fill="var(--muted)">
                                    {m.label}
                                </text>
                            )}
                        </g>
                    ))}

                    {/* data */}
                    {series.map((s) =>
                        s.area && s.points.length > 1 ? (
                            <path key={`a${s.id}`} d={areaOf(s)} fill={s.color} opacity={0.1} />
                        ) : null
                    )}
                    {series.map((s) => (
                        <path
                            key={`l${s.id}`}
                            d={pathOf(s)}
                            fill="none"
                            stroke={s.color}
                            strokeWidth="2"
                            strokeLinejoin="round"
                            strokeLinecap="round"
                            strokeDasharray={s.dashed ? '5 4' : undefined}
                        />
                    ))}
                    {dots.map((d, i) => (
                        <g key={`d${i}`}>
                            <circle cx={sx(d.x)} cy={sy(d.y)} r="6" fill="var(--surface)" />
                            <circle cx={sx(d.x)} cy={sy(d.y)} r="4.5" fill={d.color ?? 'var(--accent)'} />
                            <text x={sx(d.x) + 9} y={sy(d.y) - 8} fontSize="11" fontWeight="600" fill="var(--ink)">
                                {d.label}
                            </text>
                        </g>
                    ))}

                    {/* hover layer */}
                    {hover && hoverPx !== null && (
                        <g>
                            <line x1={hoverPx} x2={hoverPx} y1={M.top} y2={M.top + ih} stroke="var(--ink-2)" strokeWidth="1" opacity="0.5" />
                            {hover.map(({ s, p }) => (
                                <g key={`h${s.id}`}>
                                    <circle cx={sx(p!.x)} cy={sy(p!.y)} r="6" fill="var(--surface)" />
                                    <circle cx={sx(p!.x)} cy={sy(p!.y)} r="4" fill={s.color} />
                                </g>
                            ))}
                        </g>
                    )}
                </svg>
                {hover && hover.length > 0 && hoverPx !== null && (
                    <div
                        className="pointer-events-none absolute top-2 z-10 min-w-36 rounded-lg border border-line bg-surface px-3 py-2 text-xs shadow-lg"
                        style={hoverPx > width / 2 ? { right: width - hoverPx + 12 } : { left: hoverPx + 12 }}
                    >
                        <div className="mb-1 text-muted">{(xTooltip ?? xFormat)(hover[0].p!.x)}</div>
                        {hover.map(({ s, p }) => (
                            <div key={s.id} className="flex items-center gap-2 py-0.5">
                                <svg width="12" height="6" aria-hidden>
                                    <line x1="0" y1="3" x2="12" y2="3" stroke={s.color} strokeWidth="2" />
                                </svg>
                                <span className="tnum font-semibold text-ink">{yFormat(p!.y)}</span>
                                <span className="text-muted">{s.label}</span>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}

/** Tiny inline curve for cards; no axes, no hover. */
export function Sparkline({ points, color = 'var(--s1)', height = 44, log }: { points: Array<{ x: number; y: number }>; color?: string; height?: number; log?: boolean }) {
    if (points.length < 2) return <div style={{ height }} />
    const xs = points.map((p) => p.x)
    const ys = points.map((p) => (log ? Math.log10(p.y) : p.y))
    const x0 = Math.min(...xs)
    const x1 = Math.max(...xs)
    // linear sparklines start at zero so a flat price reads as flat, not as a ramp
    const y0 = log ? Math.min(...ys) : 0
    const y1 = Math.max(...ys)
    const W = 200
    const d = points
        .map((p, i) => {
            const x = ((p.x - x0) / (x1 - x0 || 1)) * W
            const yv = log ? Math.log10(p.y) : p.y
            const y = height - 3 - ((yv - y0) / (y1 - y0 || 1)) * (height - 6)
            return `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`
        })
        .join('')
    return (
        <svg viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" className="w-full" style={{ height }} aria-hidden>
            <path d={`${d}L${W},${height}L0,${height}Z`} fill={color} opacity="0.1" />
            <path d={d} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
        </svg>
    )
}
