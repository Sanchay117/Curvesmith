import { describe, expect, test } from 'vitest'
import { createHash } from 'node:crypto'
import { Keypair, PublicKey, Transaction } from '@solana/web3.js'
import { validateConfigParameters } from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
    analyzePreset,
    compilePreset,
    decodeListing,
    defaultPreset,
    deriveConfigState,
    encodeListing,
    LIBRARY,
    lintPreset,
    listingInstructions,
    listingMetaFromSpec,
    planCurve,
    PresetSpec,
    quoteDecimals,
    REGISTRY_ADDRESS,
    REGISTRY_SEED,
    QUOTE_ASSETS,
    runScenario,
    SCENARIOS,
    sha256,
    specFromConfig,
    toHex,
} from '../src'

const dummy = new PublicKey('11111111111111111111111111111112')

describe('preset library', () => {
    for (const [id, spec] of Object.entries(LIBRARY)) {
        test(`${id} compiles to a config the SDK validator accepts`, () => {
            const { params } = compilePreset(spec)
            expect(() => validateConfigParameters({ ...params, leftoverReceiver: dummy })).not.toThrow()
            expect(params.curve.length).toBeLessThanOrEqual(16)
        })
        test(`${id} has no critical lint findings`, () => {
            const report = lintPreset(analyzePreset(spec))
            expect(report.findings.filter((f) => f.severity === 'critical')).toEqual([])
        })
    }
})

describe('curve planner', () => {
    const shapes: PresetSpec['pricing']['shape'][] = [
        { kind: 'constant-product' },
        { kind: 'linear' },
        { kind: 'exponential' },
        { kind: 'power', exponent: 2 },
        { kind: 'sigmoid', steepness: 12, midpoint: 0.3 },
        { kind: 'flat', bandBps: 30 },
        { kind: 'custom', points: [{ x: 0, multiple: 1 }, { x: 0.5, multiple: 1.1 }, { x: 1, multiple: 20 }] },
        {
            kind: 'tranches',
            bandBps: 50,
            tranches: Array.from({ length: 8 }, (_, i) => ({ priceMultiple: 1 + i * 0.5, share: 1 / 8 })),
        },
    ]
    for (const shape of shapes) {
        test(`${shape.kind}: strictly ascending prices, positive weights, <= 16 segments`, () => {
            const spec = defaultPreset()
            spec.pricing.shape = shape
            const plan = planCurve(spec)
            expect(plan.weights.length).toBe(plan.prices.length - 1)
            expect(plan.weights.length).toBeLessThanOrEqual(16)
            plan.prices.slice(1).forEach((p, i) => expect(p).toBeGreaterThan(plan.prices[i]))
            plan.weights.forEach((w) => expect(w).toBeGreaterThan(0))
            expect(() => compilePreset(spec)).not.toThrow()
        })
    }

    test('the designed shape is what the compiled curve actually sells', () => {
        // Linear: halfway through the sale the price should be ~ halfway between start and end.
        const spec = defaultPreset()
        spec.pricing.shape = { kind: 'linear' }
        const a = analyzePreset(spec)
        const mid = a.curve.reduce((best, p) =>
            Math.abs(p.sold - a.analysis.soldOnCurve / 2) < Math.abs(best.sold - a.analysis.soldOnCurve / 2) ? p : best
        )
        const expected = (a.analysis.startPrice + a.analysis.endPrice) / 2
        expect(Math.abs(mid.price - expected) / expected).toBeLessThan(0.03)
    })

    test('graduation price equals the final curve price (no gap into DAMM v2)', () => {
        for (const spec of Object.values(LIBRARY)) {
            const a = analyzePreset(spec)
            const last = a.curve[a.curve.length - 1]
            expect(Math.abs(last.price - a.analysis.endPrice) / a.analysis.endPrice).toBeLessThan(1e-9)
        }
    })
})

describe('registry (CSR-1)', () => {
    test('registry address is sha256(seed), matching node:crypto', () => {
        const expected = createHash('sha256').update(REGISTRY_SEED).digest()
        expect(REGISTRY_ADDRESS.toBuffer().equals(expected)).toBe(true)
        expect(toHex(sha256(new Uint8Array()))).toBe(createHash('sha256').update('').digest('hex'))
        expect(REGISTRY_ADDRESS.toBase58()).toBe('3cjzSdeXvwoke4238hghUi6dzo7cNhousyR19mNjzsBR')
    })

    test('listing memo round-trips', () => {
        const meta = listingMetaFromSpec(Keypair.generate().publicKey, LIBRARY['equity-tranches'])
        expect(decodeListing(encodeListing(meta))).toEqual(meta)
        expect(decodeListing('csr1:{bad json')).toBeNull()
        expect(decodeListing('hello')).toBeNull()
    })

    test('every library listing fits in a single transaction', () => {
        const author = Keypair.generate()
        for (const spec of Object.values(LIBRARY)) {
            const tx = new Transaction().add(
                ...listingInstructions(author.publicKey, listingMetaFromSpec(Keypair.generate().publicKey, spec))
            )
            tx.recentBlockhash = Keypair.generate().publicKey.toBase58()
            tx.feePayer = author.publicKey
            tx.sign(author)
            expect(tx.serialize().length).toBeLessThanOrEqual(1232)
        }
    })

    test('a spec rebuilt from chain recompiles to the same economics', () => {
        for (const spec of Object.values(LIBRARY)) {
            const { params } = compilePreset(spec)
            const config = deriveConfigState(params, { quoteMint: QUOTE_ASSETS.devnet[spec.quote].mint, feeClaimer: dummy, leftoverReceiver: dummy })
            const rebuilt = specFromConfig(config, 'devnet', { s: spec.pricing.shape, n: spec.name })
            expect(rebuilt.fees.schedule.startBps).toBe(spec.fees.schedule.startBps)
            expect(rebuilt.fees.creatorSharePct).toBe(spec.fees.creatorSharePct)
            expect(rebuilt.lp).toEqual(JSON.parse(JSON.stringify({ ...spec.lp })))
            expect(Math.abs(rebuilt.token.supply - spec.token.supply) / spec.token.supply).toBeLessThan(1e-9)
            const again = compilePreset(rebuilt).params
            const ratio = Number(again.migrationQuoteThreshold.toString()) / Number(params.migrationQuoteThreshold.toString())
            expect(Math.abs(ratio - 1)).toBeLessThan(0.002)
        }
    })
})

describe('scenario engine', () => {
    test('runs are reproducible from the seed', () => {
        const spec = LIBRARY['fair-meme']
        const a = analyzePreset(spec)
        const opts = { totalSupply: spec.token.supply, quoteDecimals: quoteDecimals(spec) }
        const r1 = runScenario(a.config, SCENARIOS[1], opts)
        const r2 = runScenario(a.config, SCENARIOS[1], opts)
        expect(r1.trades.length).toBe(r2.trades.length)
        expect(r1.fees).toEqual(r2.fees)
        expect(r1.graduationSec).toBe(r2.graduationSec)
    })

    test('the anti-sniper fee turns sniping into a loss; a flat 1% fee does not', () => {
        const taxed = LIBRARY['fair-meme']
        const flat: PresetSpec = JSON.parse(JSON.stringify(taxed))
        flat.fees.schedule = { mode: 'linear', startBps: 100, endBps: 100, duration: 0, periods: 0 }
        const rush = SCENARIOS.find((s) => s.id === 'sniper-rush')!
        const roi = (spec: PresetSpec) => {
            const a = analyzePreset(spec)
            const r = runScenario(a.config, rush, { totalSupply: spec.token.supply, quoteDecimals: 9 })
            return r.cohorts.find((c) => c.cohort === 'sniper')!.roiPct
        }
        expect(roi(taxed)).toBeLessThan(0)
        expect(roi(flat)).toBeGreaterThan(roi(taxed) + 20)
    })

    test('fee accounting is conserved: partner + creator + protocol equals what traders paid', () => {
        const spec = LIBRARY['agent-treasury']
        const a = analyzePreset(spec)
        const r = runScenario(a.config, SCENARIOS[0], { totalSupply: spec.token.supply, quoteDecimals: 9 })
        const paid = r.cohorts.reduce((s, c) => s + c.feesQuote, 0)
        expect(Math.abs(paid - r.fees.total) / r.fees.total).toBeLessThan(1e-6)
    })
})
