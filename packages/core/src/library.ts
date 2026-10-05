/**
 * The curated preset library. Each preset exists to show a different corner of what DBC
 * can express, and a different asset class it serves.
 */
import { PresetSpec, PRESET_SCHEMA } from './preset'

const base = {
    schema: PRESET_SCHEMA,
    activation: 'timestamp' as const,
}

export const LIBRARY: Record<string, PresetSpec> = {
    'fair-meme': {
        ...base,
        name: 'Fair Meme',
        tagline: 'Pump-style curve with a sniper tax that melts in two minutes',
        description:
            'Classic single-segment constant-product curve. A 50% fee in the first seconds decays exponentially to 1% over 120s, so bots fund the creator instead of farming them. The creator\'s bundled first buy pays the minimum fee. All graduated liquidity is permanently locked.',
        category: 'meme',
        tags: ['anti-sniper', 'locked-lp', 'fee-share'],
        quote: 'SOL',
        token: { decimals: 6, supply: 1_000_000_000, standard: 'spl', authority: 'immutable', leftover: 10 },
        pricing: { startMcap: 28, endMcap: 420, shape: { kind: 'constant-product' } },
        fees: {
            schedule: { mode: 'exponential', startBps: 5000, endBps: 100, duration: 120, periods: 60 },
            dynamic: true,
            collect: 'quote',
            creatorSharePct: 50,
            poolCreationFeeSol: 0,
            firstSwapMinFee: true,
        },
        migration: { pool: { kind: 'fixed', bps: 100 }, feePct: 0, creatorFeeSharePct: 0 },
        lp: { partner: { unlocked: 0, locked: 50 }, creator: { unlocked: 0, locked: 50 } },
    },

    'long-curve': {
        ...base,
        name: 'Long Curve',
        tagline: 'Weeks of price discovery for communities, not minutes',
        description:
            'A 16-segment exponential curve over a 400x price range with a large raise, so graduation takes sustained demand. Low 0.6% fees and 80% of them go to the creator. After graduation the DAMM v2 fee starts at 2% and decays to 0.25% as market cap grows 10x. Creator LP vests over six months.',
        category: 'community',
        tags: ['exponential', '16-segments', 'mcap-fee-scheduler', 'lp-vesting'],
        quote: 'SOL',
        token: { decimals: 6, supply: 1_000_000_000, standard: 'spl', authority: 'immutable', leftover: 10 },
        pricing: { startMcap: 15, endMcap: 6000, shape: { kind: 'exponential' } },
        fees: {
            schedule: { mode: 'exponential', startBps: 2000, endBps: 60, duration: 300, periods: 60 },
            dynamic: true,
            collect: 'quote',
            creatorSharePct: 80,
            poolCreationFeeSol: 0,
            firstSwapMinFee: true,
        },
        migration: {
            pool: {
                kind: 'custom',
                bps: 200,
                dynamic: true,
                collect: 'quote',
                marketCapSchedule: { mode: 'exponential', endBps: 25, periods: 50, priceMultiple: 10, expirySeconds: 30 * 86_400 },
            },
            feePct: 0,
            creatorFeeSharePct: 0,
        },
        lp: {
            partner: { unlocked: 0, locked: 40 },
            creator: { unlocked: 0, locked: 20, vesting: { pct: 40, cliffSeconds: 7 * 86_400, periods: 26, durationSeconds: 26 * 7 * 86_400 } },
        },
    },

    'nav-sale': {
        ...base,
        name: 'NAV Subscription',
        tagline: 'Fixed-price primary sale for tokenized funds and RWAs',
        description:
            'A flat curve: every unit sells within 1% of NAV ($1.00), like a fund subscription window. Fees are a flat 0.25% with no sniper tax because there is nothing to snipe. On completion the raise and units seed a USDC secondary market at NAV with a tight 0.25% pool fee. The issuer keeps metadata authority for disclosures.',
        category: 'rwa',
        tags: ['flat', 'usdc', 'fixed-price', 'issuer-controlled'],
        quote: 'USDC',
        token: { decimals: 6, supply: 2_250_000, standard: 'spl', authority: 'partner-update', leftover: 1 },
        pricing: { startMcap: 2_250_000, endMcap: 0, shape: { kind: 'flat', bandBps: 100 } },
        fees: {
            schedule: { mode: 'linear', startBps: 25, endBps: 25, duration: 0, periods: 0 },
            dynamic: false,
            collect: 'quote',
            creatorSharePct: 0,
            poolCreationFeeSol: 0,
            firstSwapMinFee: false,
        },
        migration: { pool: { kind: 'fixed', bps: 25 }, feePct: 0, creatorFeeSharePct: 0 },
        lp: { partner: { unlocked: 0, locked: 100 }, creator: { unlocked: 0, locked: 0 } },
    },

    'equity-tranches': {
        ...base,
        name: 'Equity Tranches',
        tagline: 'IPO-style book: four priced tranches, then a live market',
        description:
            'A stepped curve built from flat price bands: 40% of the float at $1.00, 30% at $1.25, 20% at $1.60, 10% at $2.00. Each tranche is a hard repricing, like book-building rounds, so early backers get a transparent discount instead of a lottery. 10% team allocation is locked for a year then vests monthly. Creator LP vests over 12 months.',
        category: 'equity',
        tags: ['tranches', 'usdc', 'team-vesting', 'lp-vesting'],
        quote: 'USDC',
        token: { decimals: 6, supply: 10_000_000, standard: 'spl', authority: 'partner-update', leftover: 1 },
        pricing: {
            startMcap: 10_000_000,
            endMcap: 0,
            shape: {
                kind: 'tranches',
                bandBps: 50,
                tranches: [
                    { priceMultiple: 1, share: 0.4 },
                    { priceMultiple: 1.25, share: 0.3 },
                    { priceMultiple: 1.6, share: 0.2 },
                    { priceMultiple: 2, share: 0.1 },
                ],
            },
        },
        fees: {
            schedule: { mode: 'linear', startBps: 50, endBps: 50, duration: 0, periods: 0 },
            dynamic: false,
            collect: 'quote',
            creatorSharePct: 50,
            poolCreationFeeSol: 0,
            firstSwapMinFee: false,
        },
        migration: { pool: { kind: 'fixed', bps: 30 }, feePct: 0, creatorFeeSharePct: 0 },
        lp: {
            partner: { unlocked: 0, locked: 50 },
            creator: { unlocked: 0, locked: 0, vesting: { pct: 50, cliffSeconds: 30 * 86_400, periods: 12, durationSeconds: 12 * 30 * 86_400 } },
        },
        creatorAllocation: { pct: 10, cliffSeconds: 365 * 86_400, cliffUnlockPct: 0, periods: 12, durationSeconds: 12 * 30 * 86_400 },
    },

    's-curve': {
        ...base,
        name: 'S-Curve Discovery',
        tagline: 'Cheap accumulation, a fast middle, a calm run into graduation',
        description:
            'A sigmoid price path fitted with 16 segments: the first third of the sale barely moves the price, the middle reprices quickly, and the final stretch flattens so the graduation buyer is not the most exposed. Linear 25% to 0.8% fee decay over 90s.',
        category: 'experimental',
        tags: ['sigmoid', '16-segments', 'novel-curve'],
        quote: 'SOL',
        token: { decimals: 6, supply: 1_000_000_000, standard: 'spl', authority: 'immutable', leftover: 10 },
        pricing: { startMcap: 30, endMcap: 500, shape: { kind: 'sigmoid', steepness: 9, midpoint: 0.5 } },
        fees: {
            schedule: { mode: 'linear', startBps: 2500, endBps: 80, duration: 90, periods: 45 },
            dynamic: true,
            collect: 'quote',
            creatorSharePct: 40,
            poolCreationFeeSol: 0,
            firstSwapMinFee: true,
        },
        migration: { pool: { kind: 'fixed', bps: 100 }, feePct: 0, creatorFeeSharePct: 0 },
        lp: { partner: { unlocked: 0, locked: 50 }, creator: { unlocked: 0, locked: 50 } },
    },

    'agent-treasury': {
        ...base,
        name: 'Agent Treasury',
        tagline: 'Curve fees fund an AI agent\'s compute, forever',
        description:
            'Built for AI-agent tokens: 90% of curve trading fees and 100% of a 2% graduation fee go to the creator, which is the agent\'s own wallet. A linear curve keeps the agent\'s funding predictable. After graduation, the agent owns half of the LP (locked), so DAMM v2 trading fees keep paying for inference.',
        category: 'ai',
        tags: ['creator-fees', 'migration-fee', 'linear'],
        quote: 'SOL',
        token: { decimals: 6, supply: 1_000_000_000, standard: 'spl', authority: 'creator-update', leftover: 10 },
        pricing: { startMcap: 40, endMcap: 450, shape: { kind: 'linear' } },
        fees: {
            schedule: { mode: 'exponential', startBps: 3000, endBps: 100, duration: 60, periods: 30 },
            dynamic: true,
            collect: 'quote',
            creatorSharePct: 90,
            poolCreationFeeSol: 0,
            firstSwapMinFee: true,
        },
        migration: { pool: { kind: 'custom', bps: 100, dynamic: true, collect: 'quote' }, feePct: 2, creatorFeeSharePct: 100 },
        lp: { partner: { unlocked: 0, locked: 50 }, creator: { unlocked: 0, locked: 50 } },
    },

    'creator-coin': {
        ...base,
        name: 'Creator Coin',
        tagline: 'Early supporters rewarded first, creators paid on every trade',
        description:
            'A concave power curve (exponent 0.5): price rises fastest at the start, so the first supporters get the best entries without a winner-takes-all bottom. 70% of fees go to the creator. 5% creator allocation with a 90-day cliff.',
        category: 'creator',
        tags: ['power-curve', 'creator-allocation', 'fee-share'],
        quote: 'SOL',
        token: { decimals: 6, supply: 1_000_000_000, standard: 'spl', authority: 'creator-update', leftover: 10 },
        pricing: { startMcap: 25, endMcap: 350, shape: { kind: 'power', exponent: 0.5 } },
        fees: {
            schedule: { mode: 'exponential', startBps: 4000, endBps: 150, duration: 90, periods: 45 },
            dynamic: true,
            collect: 'quote',
            creatorSharePct: 70,
            poolCreationFeeSol: 0,
            firstSwapMinFee: true,
        },
        migration: { pool: { kind: 'fixed', bps: 200 }, feePct: 0, creatorFeeSharePct: 0 },
        lp: { partner: { unlocked: 0, locked: 40 }, creator: { unlocked: 0, locked: 60 } },
        creatorAllocation: { pct: 5, cliffSeconds: 90 * 86_400, cliffUnlockPct: 20, periods: 9, durationSeconds: 270 * 86_400 },
    },

    speedrun: {
        ...base,
        name: 'Speedrun',
        tagline: 'A tiny 2 SOL raise to watch the full lifecycle in a minute',
        description:
            'Same mechanics as Fair Meme at 1/150th of the scale. Built for demos and testing: launch, buy, graduate to DAMM v2 and claim fees on devnet with a couple of airdropped SOL.',
        category: 'experimental',
        tags: ['demo', 'devnet', 'full-lifecycle'],
        quote: 'SOL',
        token: { decimals: 6, supply: 1_000_000_000, standard: 'spl', authority: 'immutable', leftover: 10 },
        pricing: { startMcap: 0.7, endMcap: 9.8, shape: { kind: 'constant-product' } },
        fees: {
            schedule: { mode: 'exponential', startBps: 1000, endBps: 100, duration: 30, periods: 15 },
            dynamic: true,
            collect: 'quote',
            creatorSharePct: 50,
            poolCreationFeeSol: 0,
            firstSwapMinFee: true,
        },
        migration: { pool: { kind: 'fixed', bps: 100 }, feePct: 0, creatorFeeSharePct: 0 },
        lp: { partner: { unlocked: 0, locked: 50 }, creator: { unlocked: 0, locked: 50 } },
    },
}

export const LIBRARY_IDS = Object.keys(LIBRARY)
