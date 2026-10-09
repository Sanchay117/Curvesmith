import { describe, expect, test } from 'vitest'
import { PublicKey } from '@solana/web3.js'
import { compilePreset, defaultPreset, deriveConfigState, formatSwapQuote, PoolSnapshot, quoteSwap, QUOTE_ASSETS, SimPool } from '../src'

describe('MCP quote units', () => {
    for (const quote of ['SOL', 'USDC'] as const) {
        for (const collect of ['quote', 'output'] as const) {
            for (const side of ['buy', 'sell'] as const) test(`${quote} ${collect} fees on ${side}`, () => {
                const spec = defaultPreset()
                spec.quote = quote
                spec.fees.collect = collect
                spec.fees.dynamic = false
                const asset = QUOTE_ASSETS['mainnet-beta'][quote]
                const config = deriveConfigState(compilePreset(spec).params, { quoteMint: asset.mint, feeClaimer: PublicKey.default, leftoverReceiver: PublicKey.default })
                const sim = new SimPool(config, { startTime: 0, startSlot: 0 })
                const seedBuy = sim.swap({ side: 'buy', amountIn: config.migrationQuoteThreshold.divn(10), mode: 'partial-fill' }, 1)
                const snap: PoolSnapshot = { address: PublicKey.default, configAddress: PublicKey.default, config, pool: sim.pool }
                const raw = quoteSwap(snap, side, side === 'buy' ? config.migrationQuoteThreshold.divn(20) : seedBuy.amountOut.divn(2), { unix: 2, slot: 5 })
                expect(raw.tradingFee.add(raw.protocolFee).gtn(0)).toBe(true)
                const shown = formatSwapQuote(snap, side, raw, asset.decimals)
                const baseFee = collect === 'output' && side === 'buy'
                const decimals = baseFee ? config.tokenDecimal : asset.decimals
                expect(shown.feeDecimals).toBe(decimals)
                expect(shown.feeMint).toBe((baseFee ? sim.state.baseMint : asset.mint).toBase58())
                expect(shown.fee).toBeCloseTo(raw.tradingFee.add(raw.protocolFee).toNumber() / 10 ** decimals, 10)
                expect(shown.out).toBeCloseTo(raw.outputAmount.toNumber() / 10 ** (side === 'buy' ? config.tokenDecimal : asset.decimals), 8)
                expect(shown.partialFill).toBe(!raw.amountLeft.isZero())
            })
        }
    }
})
