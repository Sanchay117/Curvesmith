/**
 * Seeds devnet with a live marketplace: publishes every library preset, launches demo tokens
 * with real trades, and drives the Speedrun token through graduation into DAMM v2.
 *
 * Idempotent: presets already listed by this author are reused, so it can be re-run.
 * Writes everything it did to deployments/devnet.json.
 *
 *   pnpm --filter @curvesmith/cli exec tsx src/seed-devnet.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import {
    Connection,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    sendAndConfirmTransaction,
    SystemProgram,
    Transaction,
} from '@solana/web3.js'
import BN from 'bn.js'
import {
    buildClaimTransaction,
    buildLaunchTransaction,
    buildMigrateTransaction,
    buildPublishTransactions,
    buildSwapTransaction,
    chainTime,
    fetchListings,
    LIBRARY,
    LIBRARY_IDS,
    loadPool,
    quoteSwap,
} from '@curvesmith/core'

const root = path.resolve(process.env.INIT_CWD ?? process.cwd())
const repo = fs.existsSync(path.join(root, 'pnpm-workspace.yaml')) ? root : path.resolve(root, '../..')
const connection = new Connection(process.env.RPC ?? 'https://api.devnet.solana.com', 'confirmed')
const author = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(path.join(repo, '.keys/id.json'), 'utf8'))))
const outFile = path.join(repo, 'deployments/devnet.json')
const log: Record<string, unknown> = fs.existsSync(outFile) ? JSON.parse(fs.readFileSync(outFile, 'utf8')) : {}
const save = () => {
    fs.mkdirSync(path.dirname(outFile), { recursive: true })
    fs.writeFileSync(outFile, JSON.stringify(log, null, 2))
}
const sol = (x: number) => new BN(Math.round(x * LAMPORTS_PER_SOL))

async function send(label: string, tx: Transaction, signers: Keypair[]) {
    for (let attempt = 0; ; attempt++) {
        try {
            const sig = await sendAndConfirmTransaction(connection, tx, signers, { commitment: 'confirmed' })
            console.log(`  ${label}: ${sig}`)
            return sig
        } catch (e) {
            const msg = (e as Error).message
            if (attempt < 2 && /blockhash|timeout|429|fetch failed/i.test(msg)) {
                console.log(`  ${label}: retrying (${msg.slice(0, 60)})`)
                const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed')
                tx.recentBlockhash = blockhash
                tx.lastValidBlockHeight = lastValidBlockHeight
                tx.signatures = []
                continue
            }
            throw e
        }
    }
}

/** Traders are deterministic per run name so re-runs reuse their leftover balances. */
function trader(i: number): Keypair {
    const file = path.join(repo, `.keys/trader-${i}.json`)
    if (fs.existsSync(file)) return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(fs.readFileSync(file, 'utf8'))))
    const kp = Keypair.generate()
    fs.writeFileSync(file, JSON.stringify(Array.from(kp.secretKey)), { mode: 0o600 })
    return kp
}

async function fund(kp: Keypair, target: number) {
    const bal = await connection.getBalance(kp.publicKey)
    const need = Math.round(target * LAMPORTS_PER_SOL) - bal
    if (need <= 0.01 * LAMPORTS_PER_SOL) return
    await send(`fund ${kp.publicKey.toBase58().slice(0, 6)}`, new Transaction().add(SystemProgram.transfer({ fromPubkey: author.publicKey, toPubkey: kp.publicKey, lamports: need })), [author])
}

async function buy(who: Keypair, pool: PublicKey, amountSol: number) {
    const snap = await loadPool(connection, pool)
    if (snap.pool.poolState.quoteReserve.gte(snap.config.migrationQuoteThreshold)) return false
    const amountIn = sol(amountSol)
    const q = quoteSwap(snap, 'buy', amountIn, await chainTime(connection))
    const tx = await buildSwapTransaction(connection, snap, who.publicKey, 'buy', amountIn, q.outputAmount.muln(97).divn(100))
    await send(`buy ${amountSol} SOL`, tx, [who])
    return true
}

async function sellHalf(who: Keypair, pool: PublicKey) {
    const snap = await loadPool(connection, pool)
    const accs = await connection.getParsedTokenAccountsByOwner(who.publicKey, { mint: snap.pool.poolState.baseMint })
    const bal = new BN(accs.value[0]?.account.data.parsed.info.tokenAmount.amount ?? '0')
    if (bal.isZero()) return
    const amountIn = bal.divn(2)
    const q = quoteSwap(snap, 'sell', amountIn, await chainTime(connection))
    const tx = await buildSwapTransaction(connection, snap, who.publicKey, 'sell', amountIn, q.outputAmount.muln(97).divn(100))
    await send('sell half', tx, [who])
}

async function main() {
    console.log(`author ${author.publicKey.toBase58()}  balance ${(await connection.getBalance(author.publicKey)) / LAMPORTS_PER_SOL} SOL`)

    // 1. publish every library preset (reuse ones this author already listed)
    const existing = await fetchListings(connection)
    const configs: Record<string, string> = (log.configs as Record<string, string>) ?? {}
    for (const id of LIBRARY_IDS) {
        const spec = LIBRARY[id]
        const found = existing.find((l) => l.author.equals(author.publicKey) && l.meta.n === spec.name)
        if (found) {
            configs[id] = found.config.toBase58()
            continue
        }
        console.log(`publish ${id}`)
        const plan = await buildPublishTransactions(connection, 'devnet', author.publicKey, spec)
        await send('create config', plan.createConfigTx, [author, plan.config])
        await send('list', plan.listingTx, [author])
        configs[id] = plan.config.publicKey.toBase58()
        log.configs = configs
        save()
    }
    log.configs = configs
    save()

    // 2. demo launches on SOL presets
    const launches: Record<string, { pool: string; mint: string }> = (log.launches as typeof launches) ?? {}
    const demo: Array<{ preset: string; name: string; symbol: string; firstBuy: number }> = [
        { preset: 'speedrun', name: 'Speedrun Demo', symbol: 'SPEED', firstBuy: 0.05 },
        { preset: 'fair-meme', name: 'Curvesmith Cat', symbol: 'CSCAT', firstBuy: 0.2 },
        { preset: 'agent-treasury', name: 'Agent Zero', symbol: 'AGNT', firstBuy: 0.15 },
        { preset: 'creator-coin', name: 'Studio Coin', symbol: 'STUDIO', firstBuy: 0.1 },
        { preset: 's-curve', name: 'Sigmoid', symbol: 'SIG', firstBuy: 0.1 },
        { preset: 'long-curve', name: 'Commons', symbol: 'CMNS', firstBuy: 0.1 },
    ]
    for (const d of demo) {
        if (launches[d.symbol]) continue
        console.log(`launch ${d.symbol} on ${d.preset}`)
        const { tx, baseMint, pool } = await buildLaunchTransaction(connection, {
            config: new PublicKey(configs[d.preset]),
            creator: author.publicKey,
            name: d.name,
            symbol: d.symbol,
            uri: '',
            firstBuy: sol(d.firstBuy),
        })
        await send('launch', tx, [author, baseMint])
        launches[d.symbol] = { pool: pool.toBase58(), mint: baseMint.publicKey.toBase58() }
        log.launches = launches
        save()
    }

    // 3. organic-looking activity from three trader wallets
    const traders = [trader(1), trader(2), trader(3)]
    for (const t of traders) await fund(t, 0.9)
    if (!log.activity) {
        const plan: Array<[number, string, number]> = [
            [0, 'CSCAT', 0.12],
            [1, 'CSCAT', 0.08],
            [2, 'AGNT', 0.1],
            [0, 'STUDIO', 0.06],
            [1, 'SIG', 0.07],
            [2, 'CMNS', 0.05],
        ]
        for (const [i, sym, amt] of plan) await buy(traders[i], new PublicKey(launches[sym].pool), amt)
        await sellHalf(traders[1], new PublicKey(launches['CSCAT'].pool))
        log.activity = true
        save()
    }

    // 4. drive Speedrun to graduation, then graduate it into DAMM v2
    const speed = new PublicKey(launches['SPEED'].pool)
    let i = 0
    while (await buy(traders[i % 3], speed, 0.35)) i++
    let snap = await loadPool(connection, speed)
    if (!snap.pool.poolState.isMigrated) {
        console.log('graduate SPEED')
        const { tx, signers, dammPool } = await buildMigrateTransaction(connection, snap, author.publicKey)
        log.graduation = { signature: await send('migrate', tx, [author, ...signers]), dammPool: dammPool.toBase58() }
        save()
        snap = await loadPool(connection, speed)
    }

    // 5. the author claims partner fees earned on the graduated pool
    if (!snap.pool.poolState.partnerQuoteFee.isZero()) {
        log.claim = await send('claim partner fees', await buildClaimTransaction(connection, snap, 'partner', author.publicKey), [author])
        save()
    }
    console.log(`\ndone. author balance ${(await connection.getBalance(author.publicKey)) / LAMPORTS_PER_SOL} SOL; see deployments/devnet.json`)
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
