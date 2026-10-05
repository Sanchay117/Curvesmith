/** Compact, human number formatting: 1,284 / 12.9K / 4.2M, with sensible small-number precision. */
export function num(x: number, opts: { digits?: number; compact?: boolean } = {}): string {
    if (!Number.isFinite(x)) return '-'
    const abs = Math.abs(x)
    if (opts.compact !== false && abs >= 10_000) {
        return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(x)
    }
    if (abs === 0) return '0'
    const digits = opts.digits ?? (abs >= 100 ? 0 : abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6)
    // amounts this small are dust; prices use price() instead, which keeps the exponent
    if (abs < 1e-6) return x > 0 ? '<0.000001' : '>-0.000001'
    return x.toLocaleString('en-US', { maximumFractionDigits: digits })
}

export function pct(x: number, digits = 1): string {
    if (!Number.isFinite(x)) return '-'
    return `${x.toFixed(digits)}%`
}

export function bps(x: number): string {
    return x >= 100 ? `${(x / 100).toFixed(x % 100 === 0 ? 0 : 2)}%` : `${(x / 100).toFixed(2)}%`
}

/** Prices are tiny for 1B-supply tokens; show them in scientific-ish compact form. */
export function price(x: number): string {
    if (!Number.isFinite(x) || x === 0) return '0'
    if (x >= 0.01) return num(x, { digits: 4 })
    const exp = Math.floor(Math.log10(x))
    const mant = x / Math.pow(10, exp)
    return `${mant.toFixed(2)}e${exp}`
}

export function duration(seconds: number): string {
    if (!Number.isFinite(seconds)) return '-'
    if (seconds < 60) return `${Math.round(seconds)}s`
    if (seconds < 3600) return `${(seconds / 60).toFixed(seconds < 600 ? 1 : 0)}m`
    if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)}h`
    return `${(seconds / 86_400).toFixed(1)}d`
}

export function short(addr: string, n = 4): string {
    return addr.length <= n * 2 + 1 ? addr : `${addr.slice(0, n)}...${addr.slice(-n)}`
}

export function ago(unix: number | null): string {
    if (!unix) return ''
    const s = Math.max(0, Date.now() / 1000 - unix)
    if (s < 60) return 'just now'
    return `${duration(s)} ago`
}
