import { ElementType, ReactNode, useCallback, useEffect, useRef, useState } from 'react'
import { cx } from './ui'

/**
 * Small motion kit: scroll reveals, count-ups and ring meters, built on IntersectionObserver
 * and CSS (no animation library). Everything settles to its final state immediately when the
 * viewer prefers reduced motion; the matching CSS lives in styles.css (`lp-*` classes).
 */

export function prefersReducedMotion(): boolean {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

/** True once the element has scrolled into view (and stays true). */
export function useInView<T extends Element>(rootMargin = '0px 0px -8% 0px'): [(el: T | null) => void, boolean] {
    const [seen, setSeen] = useState(false)
    const observer = useRef<IntersectionObserver | null>(null)
    const ref = useCallback(
        (el: T | null) => {
            observer.current?.disconnect()
            if (!el || seen) return
            if (typeof IntersectionObserver === 'undefined' || prefersReducedMotion()) return setSeen(true)
            observer.current = new IntersectionObserver(
                (entries) => {
                    if (entries.some((e) => e.isIntersecting)) {
                        setSeen(true)
                        observer.current?.disconnect()
                    }
                },
                { rootMargin }
            )
            observer.current.observe(el)
        },
        [seen, rootMargin]
    )
    useEffect(() => () => observer.current?.disconnect(), [])
    return [ref, seen]
}

/** Fades and lifts its children in when they scroll into view; `delay` staggers siblings. */
export function Reveal({ children, delay = 0, className, as: Tag = 'div' }: { children: ReactNode; delay?: number; className?: string; as?: ElementType }) {
    const [ref, seen] = useInView<HTMLElement>()
    return (
        <Tag ref={ref} className={cx('lp-reveal', seen && 'is-in', className)} style={{ transitionDelay: `${delay}ms` }}>
            {children}
        </Tag>
    )
}

/** Counts from zero to `value` (ease-out) the first time it is seen. */
export function CountUp({ value, format = (n) => Math.round(n).toLocaleString('en-US'), duration = 1300, className }: { value: number; format?: (n: number) => string; duration?: number; className?: string }) {
    const [ref, seen] = useInView<HTMLSpanElement>()
    const [shown, setShown] = useState(prefersReducedMotion() ? value : 0)
    useEffect(() => {
        if (!seen) return
        if (prefersReducedMotion()) return setShown(value)
        let raf = 0
        const t0 = performance.now()
        const tick = (t: number) => {
            const p = Math.min(1, (t - t0) / duration)
            setShown(value * (1 - Math.pow(1 - p, 3)))
            if (p < 1) raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
        return () => cancelAnimationFrame(raf)
    }, [seen, value, duration])
    return (
        <span ref={ref} className={cx('tnum', className)}>
            {format(shown)}
        </span>
    )
}

/** A ring that fills to `value` (0..1) when seen, with its children centered inside. */
export function RingMeter({ value, color = 'var(--accent)', size = 112, stroke = 9, children }: { value: number; color?: string; size?: number; stroke?: number; children?: ReactNode }) {
    const [ref, seen] = useInView<HTMLDivElement>()
    const r = (size - stroke) / 2
    const c = 2 * Math.PI * r
    const v = Math.max(0, Math.min(1, value))
    return (
        <div ref={ref} className="relative grid shrink-0 place-items-center" style={{ width: size, height: size }}>
            <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="-rotate-90" aria-hidden>
                <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
                <circle
                    cx={size / 2}
                    cy={size / 2}
                    r={r}
                    fill="none"
                    stroke={color}
                    strokeWidth={stroke}
                    strokeLinecap="round"
                    strokeDasharray={c}
                    strokeDashoffset={seen ? c * (1 - v) : c}
                    style={{ transition: 'stroke-dashoffset 1.4s cubic-bezier(.2,.7,.2,1)' }}
                />
            </svg>
            <div className="absolute inset-0 grid place-items-center">{children}</div>
        </div>
    )
}
