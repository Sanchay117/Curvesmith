import { useEffect, useState } from 'react'
import { Evaluation, evaluateConfig, evaluatePreset, LIBRARY, Listing, Network, PresetSpec, specFromConfig } from '@curvesmith/core'

/**
 * Evaluations (analysis + 2 simulations + lint) cost ~20-60ms each. Cache them by key so
 * a card and its detail page share one computation, and compute off the first paint.
 */
const cache = new Map<string, Evaluation | Error>()

function compute(key: string, fn: () => Evaluation): Evaluation | Error {
    const hit = cache.get(key)
    if (hit) return hit
    let v: Evaluation | Error
    try {
        v = fn()
    } catch (e) {
        v = e as Error
    }
    cache.set(key, v)
    return v
}

export function templateEvaluation(id: string): Evaluation | Error {
    return compute(`t:${id}`, () => evaluatePreset(LIBRARY[id]))
}

export function listingSpec(l: Listing, network: Network): PresetSpec {
    return specFromConfig(l.poolConfig, network, l.meta)
}

export function listingEvaluation(l: Listing, network: Network): Evaluation | Error {
    return compute(`l:${network}:${l.config.toBase58()}:${l.signature}`, () => evaluateConfig(listingSpec(l, network), l.poolConfig))
}

/** Defers the computation one frame so pages paint their shell first. */
export function useDeferredEvaluation(fn: (() => Evaluation | Error) | null, deps: unknown[]): Evaluation | Error | null {
    const [v, setV] = useState<Evaluation | Error | null>(null)
    useEffect(() => {
        if (!fn) return setV(null)
        let alive = true
        const id = requestAnimationFrame(() => {
            const r = fn()
            if (alive) setV(r)
        })
        return () => {
            alive = false
            cancelAnimationFrame(id)
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, deps)
    return v
}
