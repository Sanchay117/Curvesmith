/**
 * Full launch lifecycle on the real programs (DBC + DAMM v2) inside LiteSVM:
 * publish preset -> launch with bundled creator buy -> trade to graduation ->
 * permissionless migration into DAMM v2 -> fee claims.
 *
 * Checks the simulator's graduation predictions against what the programs actually did.
 */
import { describe, expect, test } from 'vitest'
import { Keypair, LAMPORTS_PER_SOL, Transaction } from '@solana/web3.js'
import { createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token'
import BN from 'bn.js'
import {
    createDammV2Program,
    DAMM_V2_MIGRATION_FEE_ADDRESS,
    deriveDammV2PoolAddress,
    deriveDbcPoolAddress,
    deriveDbcPoolAuthority,
    DynamicBondingCurveClient,
    SwapMode,
} from '@meteora-ag/dynamic-bonding-curve-sdk'
import { Svm } from './svm'
import { compilePreset, LIBRARY, predictMigration, readPoolCensusFields, SimPool } from '../src'

describe('lifecycle on real programs', () => {
    test('Speedrun preset: launch, graduate, migrate to DAMM v2, claim', async () => {
        const env = new Svm().loadAccountFixtures()
        const client = new DynamicBondingCurveClient(env.connection, 'confirmed')
        const author = env.funded()
        const creator = env.funded()
        const traders = [env.funded(), env.funded(), env.funded()]
        const spec = LIBRARY['speedrun']
        const { params } = compilePreset(spec)

        // 1. publish
        const configKp = Keypair.generate()
        env.send(
            await client.partner.createConfig({
                config: configKp.publicKey,
                feeClaimer: author.publicKey,
                leftoverReceiver: author.publicKey,
                payer: author.publicKey,
                quoteMint: NATIVE_MINT,
                ...params,
            }),
            [author, configKp]
        )
        const config = (await client.state.getPoolConfig(configKp.publicKey))!

        // 2. launch with a bundled creator first buy (pays the minimum fee)
        const baseMint = Keypair.generate()
        const firstBuy = new BN(LAMPORTS_PER_SOL / 20)
        const launchTx = await client.creator.createPoolWithFirstBuy({
            createPoolParam: {
                baseMint: baseMint.publicKey,
                config: configKp.publicKey,
                name: 'Speedrun',
                symbol: 'SPEED',
                uri: 'https://example.com/speed.json',
                payer: creator.publicKey,
                poolCreator: creator.publicKey,
            },
            firstBuyParam: { buyer: creator.publicKey, buyAmount: firstBuy, minimumAmountOut: new BN(0), referralTokenAccount: null },
        })
        env.send(launchTx, [creator, baseMint])
        const poolAddr = deriveDbcPoolAddress(NATIVE_MINT, baseMint.publicKey, configKp.publicKey)
        const afterLaunch = (await client.state.getPool(poolAddr))!.poolState
        expect(readPoolCensusFields(env.svm.getAccount(poolAddr)!.data)).toEqual({ config: configKp.publicKey.toBase58(), migrated: false })
        // the creator's bundled buy paid the minimum (end) fee, not the 10% opening fee
        const feePaid = afterLaunch.metrics.totalTradingQuoteFee.add(afterLaunch.metrics.totalProtocolQuoteFee)
        expect(feePaid.muln(10_000).div(firstBuy).toNumber()).toBeLessThanOrEqual(101)

        // mirror the run in the simulator from the post-launch state
        const sim = new SimPool(config, { startTime: Number(env.now()), startSlot: Number(env.svm.getClock().slot) })
        Object.assign(sim.pool.poolState, afterLaunch)

        // 3. trade to graduation (partial fill on the final buy)
        let i = 0
        while (!sim.isComplete()) {
            env.advance(7)
            const amountIn = new BN(LAMPORTS_PER_SOL).muln(3).divn(10)
            sim.swap({ side: 'buy', amountIn, mode: 'partial-fill' }, Number(env.now()))
            env.send(
                await client.pool.swap2({
                    owner: traders[i % 3].publicKey,
                    pool: poolAddr,
                    swapBaseForQuote: false,
                    referralTokenAccount: null,
                    swapMode: SwapMode.PartialFill,
                    amountIn,
                    minimumAmountOut: new BN(0),
                }),
                [traders[i % 3]]
            )
            i++
            expect(i).toBeLessThan(50)
        }
        const completed = (await client.state.getPool(poolAddr))!
        expect(completed.poolState.quoteReserve.gte(config.migrationQuoteThreshold)).toBe(true)
        expect(completed.poolState.sqrtPrice.toString()).toBe(sim.state.sqrtPrice.toString())

        const predicted = predictMigration(config, completed)

        // 4. graduate: anyone can call it. DBC's pool authority lends rent to the new DAMM v2
        // accounts ("flash rent") and is repaid in the same instruction; Meteora keeps it funded
        // on the observed devnet deployment, so mirror that fixture here.
        env.svm.airdrop(deriveDbcPoolAuthority(), BigInt(5 * LAMPORTS_PER_SOL))
        const cranker = env.funded()
        const dammConfig = DAMM_V2_MIGRATION_FEE_ADDRESS[config.migrationFeeOption]
        const quoteVault = completed.poolState.quoteVault
        const quoteBefore = BigInt(Buffer.from(env.svm.getAccount(quoteVault)!.data.slice(64, 72)).readBigUInt64LE())
        const mig = await client.migration.migrateToDammV2({ payer: cranker.publicKey, pool: poolAddr, dammConfig })
        env.send(mig.transaction, [cranker, mig.firstPositionNftKeypair, mig.secondPositionNftKeypair].filter(Boolean) as Keypair[])

        const migrated = (await client.state.getPool(poolAddr))!.poolState
        expect(migrated.isMigrated).toBe(1)
        expect(readPoolCensusFields(env.svm.getAccount(poolAddr)!.data)).toEqual({ config: configKp.publicKey.toBase58(), migrated: true })

        const dammAddr = deriveDammV2PoolAddress(dammConfig, baseMint.publicKey, NATIVE_MINT)
        const damm = createDammV2Program(env.connection)
        const dammPool = await damm.account.pool.fetch(dammAddr)
        // the DAMM v2 pool opens exactly at the curve's final price: no gap at graduation
        expect(dammPool.sqrtPrice.toString()).toBe(config.migrationSqrtPrice.toString())

        const quoteAfter = BigInt(Buffer.from(env.svm.getAccount(quoteVault)!.data.slice(64, 72)).readBigUInt64LE())
        const deposited = new BN((quoteBefore - quoteAfter).toString())
        // deposited quote ~= prediction (the program rounds liquidity; allow 0.01%)
        const diff = deposited.sub(predicted.quoteToPool).abs()
        expect(diff.muln(10_000).div(predicted.quoteToPool).toNumber()).toBeLessThanOrEqual(1)

        // 5. author claims a positive amount. Pre-create the base ATA and use a separate
        // transaction fee payer so the author's SOL delta is exactly the claimed quote.
        expect(migrated.partnerQuoteFee.gtn(0)).toBe(true)
        const expectedClaim = BigInt(migrated.partnerQuoteFee.toString())
        env.send(new Transaction().add(createAssociatedTokenAccountIdempotentInstruction(
            author.publicKey, getAssociatedTokenAddressSync(baseMint.publicKey, author.publicKey), author.publicKey, baseMint.publicKey,
        )), [author])
        const claimTx = await client.partner.claimPartnerTradingFee({
            pool: poolAddr,
            feeClaimer: author.publicKey,
            payer: author.publicKey,
            maxBaseAmount: migrated.partnerBaseFee,
            maxQuoteAmount: migrated.partnerQuoteFee,
        })
        const before = env.svm.getBalance(author.publicKey)!
        claimTx.feePayer = cranker.publicKey
        env.send(claimTx, [cranker, author])
        const after = env.svm.getBalance(author.publicKey)!
        expect(after - before).toBe(expectedClaim)
        const claimed = (await client.state.getPool(poolAddr))!.poolState
        expect(claimed.partnerQuoteFee.isZero()).toBe(true)
    })
})
