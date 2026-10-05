import { Scenario } from './scenario'

/**
 * Built-in market scenarios. Sizes are fractions of the graduation raise, so each scenario
 * means the same thing for a 50 SOL meme curve and a 2M USDC equity raise.
 */
export const SCENARIOS: Scenario[] = [
    {
        id: 'organic',
        name: 'Organic launch',
        description: 'A steady crowd of small buyers with some profit taking. No bots.',
        horizonSec: 6 * 3600,
        seed: 7,
        agents: [
            { kind: 'creator', buyFraction: 0.02 },
            {
                kind: 'organic',
                buysPerMin: 4,
                medianBuyFraction: 0.006,
                spread: 0.9,
                sellChance: 0.25,
                sellPct: 60,
                fromSec: 5,
                toSec: 6 * 3600,
                halfLifeSec: 3 * 3600,
            },
        ],
    },
    {
        id: 'sniper-rush',
        name: 'Sniper rush',
        description: '15 bots buy inside the first 3 seconds and dump after ~90s, then the crowd arrives.',
        horizonSec: 6 * 3600,
        seed: 11,
        agents: [
            { kind: 'creator', buyFraction: 0.02 },
            { kind: 'snipers', count: 15, buyFraction: 0.03, windowSec: 3, holdSec: 90, sellPct: 100 },
            {
                kind: 'organic',
                buysPerMin: 4,
                medianBuyFraction: 0.006,
                spread: 0.9,
                sellChance: 0.25,
                sellPct: 60,
                fromSec: 20,
                toSec: 6 * 3600,
                halfLifeSec: 3 * 3600,
            },
        ],
    },
    {
        id: 'whale',
        name: 'Whale entry',
        description: 'Organic flow, then a single buyer takes a quarter of the raise ten minutes in.',
        horizonSec: 6 * 3600,
        seed: 23,
        agents: [
            { kind: 'creator', buyFraction: 0.02 },
            {
                kind: 'organic',
                buysPerMin: 3,
                medianBuyFraction: 0.006,
                spread: 0.9,
                sellChance: 0.2,
                sellPct: 50,
                fromSec: 5,
                toSec: 6 * 3600,
            },
            { kind: 'whale', atSec: 600, buyFraction: 0.25 },
        ],
    },
    {
        id: 'panic',
        name: 'Mid-curve panic',
        description: 'Hype, then every holder dumps half their bag 20 minutes in. Does the launch recover?',
        horizonSec: 8 * 3600,
        seed: 31,
        agents: [
            { kind: 'creator', buyFraction: 0.02 },
            {
                kind: 'organic',
                buysPerMin: 5,
                medianBuyFraction: 0.006,
                spread: 0.9,
                sellChance: 0.2,
                sellPct: 50,
                fromSec: 5,
                toSec: 8 * 3600,
                halfLifeSec: 4 * 3600,
            },
            { kind: 'panic', atSec: 1200, sellPct: 50 },
        ],
    },
    {
        id: 'slow-grind',
        name: 'Slow grind',
        description: 'Thin, patient demand over three days: the regime long curves and RWA raises live in.',
        horizonSec: 3 * 86_400,
        seed: 47,
        agents: [
            { kind: 'creator', buyFraction: 0.01 },
            {
                kind: 'organic',
                buysPerMin: 0.4,
                medianBuyFraction: 0.004,
                spread: 0.7,
                sellChance: 0.1,
                sellPct: 30,
                fromSec: 30,
                toSec: 3 * 86_400,
            },
        ],
    },
]

export function scenarioById(id: string): Scenario | undefined {
    return SCENARIOS.find((s) => s.id === id)
}
