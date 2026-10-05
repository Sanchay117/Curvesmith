/**
 * PresetSpec: the human-level description of a DBC launch.
 *
 * A raw DBC config is ~40 numbers (Q64.64 sqrt prices, u128 liquidities, fee numerators).
 * A PresetSpec is what a launch designer actually thinks in: market caps, a curve shape,
 * a fee decay, who owns the graduated liquidity. `compilePreset` turns one into the other.
 */

export type CurveShape =
    /** One constant-product segment from start to end price: the classic pump-style curve. */
    | { kind: 'constant-product' }
    /** Price rises linearly with the share of the sale that has been bought. */
    | { kind: 'linear' }
    /** Price compounds by the same factor for every slice of the sale (geometric). */
    | { kind: 'exponential' }
    /** price = start + (end - start) * x^exponent. exponent < 1 front-loads price growth, > 1 back-loads it. */
    | { kind: 'power'; exponent: number }
    /** S-curve: slow discovery, a fast middle, then a plateau into graduation. */
    | { kind: 'sigmoid'; steepness: number; midpoint: number }
    /** Fixed-price sale inside a narrow band. The end market cap is start * (1 + band). */
    | { kind: 'flat'; bandBps: number }
    /** Stepped price schedule, like funding rounds or IPO book-building tranches. */
    | { kind: 'tranches'; bandBps: number; tranches: Array<{ priceMultiple: number; share: number }> }
    /** Freehand: price multiple of the start price at points x in [0, 1] of the sale. */
    | { kind: 'custom'; points: Array<{ x: number; multiple: number }> }

export type CurveKind = CurveShape['kind']

export type PresetCategory = 'meme' | 'community' | 'rwa' | 'equity' | 'ai' | 'creator' | 'experimental'

export type TokenAuthority =
    | 'immutable'
    | 'creator-update'
    | 'partner-update'
    | 'creator-update-and-mint'
    | 'partner-update-and-mint'

export interface LpVesting {
    /** Share of all graduated LP (0-100) that vests instead of unlocking immediately. */
    pct: number
    /** Seconds after graduation before the first unlock. */
    cliffSeconds: number
    /** Number of linear unlock periods after the cliff. */
    periods: number
    /** Total seconds across all periods (excluding the cliff). */
    durationSeconds: number
}

export interface PresetSpec {
    schema: 'curvesmith/preset@1'
    name: string
    tagline: string
    description: string
    category: PresetCategory
    tags: string[]

    quote: 'SOL' | 'USDC'
    activation: 'timestamp' | 'slot'

    token: {
        decimals: 6 | 9
        /** Total supply in whole tokens. */
        supply: number
        standard: 'spl' | 'token2022'
        authority: TokenAuthority
        /** Whole tokens reserved for the leftover receiver (absorbs rounding; can be tiny). */
        leftover: number
    }

    pricing: {
        /** Fully diluted market cap at the first trade, in quote units (SOL or USDC). */
        startMcap: number
        /** Fully diluted market cap at graduation. Ignored by shapes that define their own end (flat, tranches, custom). */
        endMcap: number
        shape: CurveShape
    }

    fees: {
        /** Base fee schedule. start == end gives a flat fee. */
        schedule: {
            mode: 'linear' | 'exponential'
            startBps: number
            endBps: number
            /** Seconds (or slots) over which the fee decays from start to end. */
            duration: number
            periods: number
        }
        /** Volatility-scaled surcharge on top of the base fee (DLMM-style). */
        dynamic: boolean
        collect: 'quote' | 'output'
        /** Share of the trading fee (after the 20% protocol cut) paid to the token creator; the rest goes to the preset author. */
        creatorSharePct: number
        /** One-off fee in SOL a creator pays to launch from this preset (90% to author, 10% protocol). */
        poolCreationFeeSol: number
        /** Lets the creator's bundled first buy pay the minimum fee instead of the sniper-tax fee. */
        firstSwapMinFee: boolean
    }

    migration: {
        /** Fee of the DAMM v2 pool the token graduates into. */
        pool:
            | { kind: 'fixed'; bps: 25 | 30 | 100 | 200 | 400 | 600 }
            | {
                  kind: 'custom'
                  bps: number
                  dynamic: boolean
                  collect: 'quote' | 'output' | 'compounding'
                  compoundingBps?: number
                  /** Optional DAMM v2 fee that decays as the token's market cap grows. */
                  marketCapSchedule?: {
                      mode: 'linear' | 'exponential'
                      endBps: number
                      periods: number
                      priceMultiple: number
                      expirySeconds: number
                  }
              }
        /** Percent of the raise taken as a graduation fee (0-99). */
        feePct: number
        /** Creator's share of that graduation fee (0-100); the rest goes to the author. */
        creatorFeeSharePct: number
    }

    /** Ownership of graduated DAMM v2 liquidity. All percentages across both parties must sum to 100. */
    lp: {
        partner: { unlocked: number; locked: number; vesting?: LpVesting }
        creator: { unlocked: number; locked: number; vesting?: LpVesting }
    }

    /** Optional creator token allocation, locked and vested after graduation. */
    creatorAllocation?: {
        /** Percent of total supply (0-50). */
        pct: number
        cliffSeconds: number
        /** Percent of the allocation unlocked at the cliff. */
        cliffUnlockPct: number
        periods: number
        durationSeconds: number
    }
}

export const PRESET_SCHEMA = 'curvesmith/preset@1' as const

export function lpTotal(spec: PresetSpec): number {
    const { partner, creator } = spec.lp
    return (
        partner.unlocked +
        partner.locked +
        (partner.vesting?.pct ?? 0) +
        creator.unlocked +
        creator.locked +
        (creator.vesting?.pct ?? 0)
    )
}

/** Shapes whose end market cap is determined by the shape itself. */
export function resolveEndMcap(spec: PresetSpec): number {
    const { startMcap, endMcap, shape } = spec.pricing
    switch (shape.kind) {
        case 'flat':
            return startMcap * (1 + shape.bandBps / 10_000)
        case 'tranches': {
            const last = shape.tranches[shape.tranches.length - 1]
            return startMcap * last.priceMultiple * (1 + shape.bandBps / 10_000)
        }
        case 'custom':
            return startMcap * shape.points[shape.points.length - 1].multiple
        default:
            return endMcap
    }
}

export function clonePreset(spec: PresetSpec): PresetSpec {
    return JSON.parse(JSON.stringify(spec))
}

/** A neutral starting point the Studio opens with. */
export function defaultPreset(): PresetSpec {
    return {
        schema: PRESET_SCHEMA,
        name: 'Untitled preset',
        tagline: 'A fresh launch design',
        description: '',
        category: 'meme',
        tags: [],
        quote: 'SOL',
        activation: 'timestamp',
        token: { decimals: 6, supply: 1_000_000_000, standard: 'spl', authority: 'immutable', leftover: 10 },
        pricing: { startMcap: 30, endMcap: 400, shape: { kind: 'constant-product' } },
        fees: {
            schedule: { mode: 'exponential', startBps: 5000, endBps: 100, duration: 120, periods: 60 },
            dynamic: true,
            collect: 'quote',
            creatorSharePct: 50,
            poolCreationFeeSol: 0,
            firstSwapMinFee: true,
        },
        migration: { pool: { kind: 'fixed', bps: 100 }, feePct: 0, creatorFeeSharePct: 0 },
        lp: {
            partner: { unlocked: 0, locked: 50 },
            creator: { unlocked: 0, locked: 50 },
        },
    }
}
