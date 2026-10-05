/**
 * Differential tests: Curvesmith's off-chain model vs the real DBC program binary.
 *
 * 1. Parity: `deriveConfigState(compilePreset(spec))` must equal, field for field, the
 *    PoolConfig account the program writes for the same parameters.
 * 2. Replay: a seeded random sequence of buys and sells is applied both to a SimPool and to
 *    a real pool in LiteSVM. After every swap, price, reserves, fee buckets and the
 *    volatility tracker must be identical to the lamport.
 */
import { describe, expect, test } from 'vitest'
import { Keypair, PublicKey } from '@solana/web3.js'
import { getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import BN from 'bn.js'
import {
    deriveDbcPoolAddress,
    DynamicBondingCurveClient,
    SwapMode,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { Svm } from './svm'
import { compilePreset } from '../src/curve'
import { deriveConfigState } from '../src/onchain'
import { initialBaseSupply, SimPool } from '../src/sim/pool'
import { mulberry32 } from '../src/sim/rng'
import { defaultPreset, PresetSpec } from '../src/preset'

function norm(x: unknown): unknown {
    if (BN.isBN(x)) return (x as BN).toString()
    if (x instanceof PublicKey) return x.toBase58()
    if (Array.isArray(x)) return x.map(norm)
    if (x && typeof x === 'object') {
        const out: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(x)) out[k] = norm(v)
        return out
    }
    return x
}

function variants(): Array<[string, PresetSpec]> {
    const base = defaultPreset()
    const v = (name: string, edit: (s: PresetSpec) => void): [string, PresetSpec] => {
        const s = defaultPreset()
        edit(s)
        return [name, s]
    }
    return [
        ['constant-product, exp fee decay, dynamic fee', base],
        v('exponential, linear decay, output-token fees, 30% creator share', (s) => {
            s.pricing.shape = { kind: 'exponential' }
            s.fees.schedule = { mode: 'linear', startBps: 2500, endBps: 100, duration: 60, periods: 30 }
            s.fees.collect = 'output'
            s.fees.creatorSharePct = 30
        }),
        v('tranches in USDC with slot activation', (s) => {
            s.quote = 'USDC'
            s.activation = 'slot'
            s.pricing = {
                startMcap: 2_000_000,
                endMcap: 0,
                shape: {
                    kind: 'tranches',
                    bandBps: 50,
                    tranches: [
                        { priceMultiple: 1, share: 0.4 },
                        { priceMultiple: 1.25, share: 0.35 },
                        { priceMultiple: 1.6, share: 0.25 },
                    ],
                },
            }
            s.fees.schedule = { mode: 'linear', startBps: 100, endBps: 100, duration: 0, periods: 0 }
            s.fees.dynamic = false
        }),
        v('sigmoid with custom DAMM v2 pool and creator vesting', (s) => {
            s.pricing.shape = { kind: 'sigmoid', steepness: 10, midpoint: 0.5 }
            s.migration = {
                pool: { kind: 'custom', bps: 50, dynamic: true, collect: 'quote' },
                feePct: 5,
                creatorFeeSharePct: 50,
            }
            s.creatorAllocation = { pct: 5, cliffSeconds: 86_400, cliffUnlockPct: 10, periods: 10, durationSeconds: 864_000 }
            s.lp = {
                partner: { unlocked: 10, locked: 40 },
                creator: { unlocked: 10, locked: 0, vesting: { pct: 40, cliffSeconds: 86_400, periods: 4, durationSeconds: 4 * 604_800 } },
            }
        }),
        v('flat fixed-price sale', (s) => {
            s.pricing = { startMcap: 1000, endMcap: 0, shape: { kind: 'flat', bandBps: 100 } }
            s.fees.schedule = { mode: 'linear', startBps: 50, endBps: 50, duration: 0, periods: 0 }
            s.fees.dynamic = false
        }),
    ]
}

/** The program reads USDC's mint account, so clone a minimal 6-decimal SPL mint into the SVM. */
function installUsdcLikeMint(env: Svm, mint: PublicKey) {
    const data = new Uint8Array(82)
    const view = new DataView(data.buffer)
    view.setUint32(0, 0, true) // no mint authority
    view.setBigUint64(36, 0n, true) // supply
    data[44] = 6 // decimals
    data[45] = 1 // initialized
    env.svm.setAccount(mint, {
        lamports: 1_461_600,
        data,
        owner: TOKEN_PROGRAM_ID,
        executable: false,
        rentEpoch: 0,
    })
}

describe('dynamic-supply configs (how most launchpads deploy)', () => {
    test('initialBaseSupply matches what the program mints into the pool', async () => {
        const env = new Svm()
        const client = new DynamicBondingCurveClient(env.connection, 'confirmed')
        const partner = env.funded()
        const creator = env.funded()
        const { params } = compilePreset(defaultPreset())
        const dynamic = { ...params, tokenSupply: null }
        const configKp = Keypair.generate()
        env.send(
            await client.partner.createConfig({
                config: configKp.publicKey,
                feeClaimer: partner.publicKey,
                leftoverReceiver: partner.publicKey,
                payer: partner.publicKey,
                quoteMint: NATIVE_MINT,
                ...dynamic,
            }),
            [partner, configKp]
        )
        const config = (await client.state.getPoolConfig(configKp.publicKey))!
        expect(config.fixedTokenSupplyFlag).toBe(0)
        const baseMint = Keypair.generate()
        env.send(
            await client.creator.createPool({
                baseMint: baseMint.publicKey,
                config: configKp.publicKey,
                name: 'Dyn',
                symbol: 'DYN',
                uri: 'https://example.com/d.json',
                payer: creator.publicKey,
                poolCreator: creator.publicKey,
            }),
            [creator, baseMint]
        )
        const pool = (await client.state.getPool(deriveDbcPoolAddress(NATIVE_MINT, baseMint.publicKey, configKp.publicKey)))!
        expect(initialBaseSupply(config).toString()).toBe(pool.poolState.baseReserve.toString())
    })
})

describe('differential: Curvesmith model vs real DBC program (LiteSVM)', () => {
    for (const [name, spec] of variants()) {
        test(`config parity + swap replay: ${name}`, async () => {
            const env = new Svm()
            const client = new DynamicBondingCurveClient(env.connection, 'confirmed')
            const partner = env.funded()
            const creator = env.funded()

            let quoteMint = NATIVE_MINT
            if (spec.quote === 'USDC') {
                quoteMint = Keypair.generate().publicKey
                installUsdcLikeMint(env, quoteMint)
            }

            const { params } = compilePreset(spec)
            const configKp = Keypair.generate()
            const tx = await client.partner.createConfig({
                config: configKp.publicKey,
                feeClaimer: partner.publicKey,
                leftoverReceiver: partner.publicKey,
                payer: partner.publicKey,
                quoteMint,
                ...params,
            })
            env.send(tx, [partner, configKp])

            const onchain = (await client.state.getPoolConfig(configKp.publicKey))!
            const derived = deriveConfigState(params, {
                quoteMint,
                feeClaimer: partner.publicKey,
                leftoverReceiver: partner.publicKey,
            })
            expect(norm(derived)).toEqual(norm(onchain))

            if (spec.quote === 'USDC') return // buying needs funded USDC accounts; parity is the point here

            const baseMint = Keypair.generate()
            const poolTx = await client.creator.createPool({
                baseMint: baseMint.publicKey,
                config: configKp.publicKey,
                name: 'Diff',
                symbol: 'DIFF',
                uri: 'https://example.com/diff.json',
                payer: creator.publicKey,
                poolCreator: creator.publicKey,
            })
            env.send(poolTx, [creator, baseMint])
            const poolAddr = deriveDbcPoolAddress(quoteMint, baseMint.publicKey, configKp.publicKey)

            const startPool = (await client.state.getPool(poolAddr))!
            const sim = new SimPool(onchain, {
                startTime: Number(env.now()),
                startSlot: Number(env.svm.getClock().slot),
            })
            expect(norm(sim.state.baseReserve)).toEqual(norm(startPool.poolState.baseReserve))
            expect(norm(sim.state.activationPoint)).toEqual(norm(startPool.poolState.activationPoint))

            const rng = mulberry32(42)
            const traders = Array.from({ length: 4 }, () => env.funded(10_000))
            const holdings = traders.map(() => new BN(0))
            const threshold = onchain.migrationQuoteThreshold

            for (let step = 0; step < 60 && !sim.isComplete(); step++) {
                env.advance(Math.floor(rng() * 25))
                const t = Number(env.now())
                const i = Math.floor(rng() * traders.length)
                const sell = holdings[i].gtn(0) && rng() < 0.35
                let amountIn: BN
                if (sell) {
                    amountIn = holdings[i].muln(Math.floor(20 + rng() * 80)).divn(100)
                    if (amountIn.isZero()) continue
                } else {
                    // buys sized as 1-12% of the graduation threshold
                    amountIn = threshold.muln(Math.floor(1 + rng() * 12)).divn(100)
                }

                const simTrade = sim.swap(
                    { side: sell ? 'sell' : 'buy', amountIn, mode: sell ? 'exact-in' : 'partial-fill' },
                    t
                )

                const swapTx = await client.pool.swap2({
                    owner: traders[i].publicKey,
                    pool: poolAddr,
                    swapBaseForQuote: sell,
                    referralTokenAccount: null,
                    swapMode: sell ? SwapMode.ExactIn : SwapMode.PartialFill,
                    amountIn,
                    minimumAmountOut: new BN(0),
                })
                env.send(swapTx, [traders[i]])

                holdings[i] = sell ? holdings[i].sub(amountIn) : holdings[i].add(simTrade.amountOut)

                const real = (await client.state.getPool(poolAddr))!.poolState
                const s = sim.state
                const pick = (p: typeof s) => ({
                    sqrtPrice: p.sqrtPrice,
                    baseReserve: p.baseReserve,
                    quoteReserve: p.quoteReserve,
                    partnerQuoteFee: p.partnerQuoteFee,
                    partnerBaseFee: p.partnerBaseFee,
                    creatorQuoteFee: p.creatorQuoteFee,
                    creatorBaseFee: p.creatorBaseFee,
                    protocolQuoteFee: p.protocolQuoteFee,
                    protocolBaseFee: p.protocolBaseFee,
                    volatilityTracker: p.volatilityTracker,
                    metrics: p.metrics,
                })
                expect(norm(pick(s)), `step ${step} (${sell ? 'sell' : 'buy'} ${amountIn.toString()})`).toEqual(
                    norm(pick(real))
                )

                if (!sell) {
                    const ata = getAssociatedTokenAddressSync(baseMint.publicKey, traders[i].publicKey)
                    const acc = env.svm.getAccount(ata)!
                    const bal = new BN(Buffer.from(acc.data.slice(64, 72)), 'le')
                    expect(bal.toString()).toEqual(holdings[i].toString())
                }
            }
        })
    }
})
