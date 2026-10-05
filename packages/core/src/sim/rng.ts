/** Small, fast, seedable PRNG so every simulation is reproducible from its seed. */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0
    return () => {
        a = (a + 0x6d2b79f5) >>> 0
        let t = a
        t = Math.imul(t ^ (t >>> 15), t | 1)
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296
    }
}

/** Exponential inter-arrival time for a Poisson process with the given rate (events per second). */
export function expSample(rng: () => number, ratePerSec: number): number {
    return -Math.log(1 - rng()) / ratePerSec
}

/** Log-normal sample with the given median and log-space sigma. */
export function lognormal(rng: () => number, median: number, sigma: number): number {
    // Box-Muller
    const u = Math.max(1e-12, rng())
    const v = rng()
    const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
    return median * Math.exp(sigma * z)
}
