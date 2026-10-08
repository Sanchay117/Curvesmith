import { useMemo, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { useQueryClient } from '@tanstack/react-query'
import BN from 'bn.js'
import Decimal from 'decimal.js'
import { deriveDammV2PoolAddress, getPriceFromSqrtPrice } from '@meteora-ag/dynamic-bonding-curve-sdk'
import {
    analyzeConfig,
    buildClaimTransaction,
    buildMigrateTransaction,
    buildSwapTransaction,
    dammConfigFor,
    explorerUrl,
    PoolSnapshot,
    quoteAssetByMint,
    quoteSwap,
    specFromConfig,
} from '@launchproof/core'
import { CurveChart, Panel } from '../components/PresetViews'
import { Address, Button, Card, Empty, Field, NumberInput, Progress, Segmented, Skeleton, Stat } from '../components/ui'
import { useChainClock, useListing, usePool, useSolBalance, useTokenBalance, useTokenMetas } from '../lib/queries'
import { useNetwork } from '../lib/network'
import { useToast } from '../lib/toast'
import { explainError, sendSteps } from '../lib/tx'
import { bps, num, pct, price } from '../lib/format'

const SLIPPAGE_BPS = 100

function toUi(x: BN, decimals: number) {
    return new Decimal(x.toString()).div(new Decimal(10).pow(decimals)).toNumber()
}
function toRaw(x: number, decimals: number) {
    return new BN(new Decimal(x).mul(new Decimal(10).pow(decimals)).floor().toFixed())
}

function SwapBox({ snap, quoteSymbol, quoteDecimals }: { snap: PoolSnapshot; quoteSymbol: string; quoteDecimals: number }) {
    const { connection } = useConnection()
    const wallet = useWallet()
    const { setVisible } = useWalletModal()
    const { network } = useNetwork()
    const toast = useToast()
    const qc = useQueryClient()
    const clock = useChainClock()
    const [side, setSide] = useState<'buy' | 'sell'>('buy')
    const [amount, setAmount] = useState(0.1)
    const [busy, setBusy] = useState(false)
    const baseDec = snap.config.tokenDecimal
    const tokenBal = useTokenBalance(wallet.publicKey, snap.pool.poolState.baseMint, snap.config.tokenType === 1)
    const solBal = useSolBalance(wallet.publicKey)

    const inDec = side === 'buy' ? quoteDecimals : baseDec
    const amountIn = amount > 0 ? toRaw(amount, inDec) : new BN(0)

    const q = useMemo(() => {
        if (!clock || amountIn.isZero()) return null
        try {
            const r = quoteSwap(snap, side, amountIn, clock)
            const outDec = side === 'buy' ? baseDec : quoteDecimals
            const fee = r.tradingFee.add(r.protocolFee).add(r.referralFee)
            const before = getPriceFromSqrtPrice(snap.pool.poolState.sqrtPrice, baseDec, quoteDecimals).toNumber()
            const after = getPriceFromSqrtPrice(r.nextSqrtPrice, baseDec, quoteDecimals).toNumber()
            const feeBase = side === 'buy' ? r.includedFeeInputAmount : r.outputAmount.add(fee)
            return {
                r,
                out: toUi(r.outputAmount, outDec),
                feeBps: feeBase.isZero() ? 0 : (Number(fee.toString()) / Number(feeBase.toString())) * 10_000,
                impact: (Math.abs(after - before) / before) * 100,
                partial: !r.amountLeft.isZero(),
                used: toUi(r.includedFeeInputAmount, inDec),
            }
        } catch (e) {
            return { error: (e as Error).message }
        }
    }, [snap, side, amountIn.toString(), clock?.unix])

    const submit = async () => {
        if (!wallet.publicKey) return setVisible(true)
        if (!q || 'error' in q) return
        try {
            setBusy(true)
            const minOut = q.r.outputAmount.muln(10_000 - SLIPPAGE_BPS).divn(10_000)
            const tx = await buildSwapTransaction(connection, snap, wallet.publicKey, side, amountIn, minOut)
            const [sig] = await sendSteps(connection, wallet, [{ label: side === 'buy' ? 'Buy' : 'Sell', tx }])
            toast({ kind: 'success', title: side === 'buy' ? 'Bought' : 'Sold', body: `${num(q.out)} ${side === 'buy' ? 'tokens' : quoteSymbol} received`, href: explorerUrl(network, 'tx', sig) })
            qc.invalidateQueries({ queryKey: ['pool'] })
            qc.invalidateQueries({ queryKey: ['bal'] })
            qc.invalidateQueries({ queryKey: ['sol'] })
        } catch (e) {
            toast({ kind: 'error', title: 'Swap failed', body: explainError(e) })
        } finally {
            setBusy(false)
        }
    }

    const tokenUi = tokenBal.data !== undefined ? toUi(new BN(tokenBal.data.toString()), baseDec) : null
    return (
        <Card>
            <Segmented
                value={side}
                onChange={(v) => {
                    setSide(v)
                    setAmount(v === 'buy' ? 0.1 : Math.floor((tokenUi ?? 0) / 2))
                }}
                options={[
                    { value: 'buy', label: 'Buy' },
                    { value: 'sell', label: 'Sell' },
                ]}
            />
            <div className="mt-4">
                <Field
                    label={side === 'buy' ? `Pay (${quoteSymbol})` : 'Sell (tokens)'}
                    hint={
                        side === 'buy'
                            ? solBal.data !== undefined && quoteSymbol === 'SOL'
                                ? `balance ${num(solBal.data / 1e9)}`
                                : undefined
                            : tokenUi !== null
                              ? `balance ${num(tokenUi)}`
                              : undefined
                    }
                >
                    <NumberInput value={amount} onChange={(v) => setAmount(Math.max(0, v))} suffix={side === 'buy' ? quoteSymbol : 'tokens'} />
                </Field>
                {side === 'sell' && tokenUi ? (
                    <div className="mt-2 flex gap-1.5">
                        {[25, 50, 100].map((p) => (
                            <button key={p} onClick={() => setAmount(Math.floor(((tokenUi * p) / 100) * 1e6) / 1e6)} className="rounded-md bg-surface-2 px-2 py-1 text-xs text-ink-2 hover:text-ink">
                                {p}%
                            </button>
                        ))}
                    </div>
                ) : null}
            </div>
            <div className="mt-4 space-y-1.5 rounded-xl bg-surface-2 p-3 text-[13px]">
                {q && 'error' in q ? (
                    <div className="text-critical">{q.error}</div>
                ) : q ? (
                    <>
                        <Row k="You receive" v={`${num(q.out)} ${side === 'buy' ? 'tokens' : quoteSymbol}`} strong />
                        <Row k="Fee" v={bps(q.feeBps)} />
                        <Row k="Price impact" v={pct(q.impact, 2)} />
                        <Row k="Slippage limit" v={bps(SLIPPAGE_BPS)} />
                        {q.partial && <div className="pt-1 text-xs text-ink-2">This buy completes the curve: only {num(q.used)} {quoteSymbol} is used, the rest stays in your wallet.</div>}
                    </>
                ) : (
                    <div className="text-muted">Enter an amount</div>
                )}
            </div>
            <Button className="mt-4 w-full" variant="primary" size="lg" onClick={submit} loading={busy} disabled={wallet.connected && (!q || 'error' in q)}>
                {wallet.connected ? (side === 'buy' ? 'Buy' : 'Sell') : 'Connect wallet'}
            </Button>
            <p className="mt-2 text-xs text-muted">Quotes come from the same simulator that powers the Studio, seeded with live pool state.</p>
        </Card>
    )
}

function Row({ k, v, strong }: { k: string; v: string; strong?: boolean }) {
    return (
        <div className="flex justify-between gap-3">
            <span className="text-muted">{k}</span>
            <span className={strong ? 'tnum font-semibold text-ink' : 'tnum text-ink-2'}>{v}</span>
        </div>
    )
}

function GraduateBox({ snap, quoteSymbol }: { snap: PoolSnapshot; quoteSymbol: string }) {
    const { connection } = useConnection()
    const wallet = useWallet()
    const { setVisible } = useWalletModal()
    const { network } = useNetwork()
    const toast = useToast()
    const qc = useQueryClient()
    const [busy, setBusy] = useState(false)
    const dammPool = deriveDammV2PoolAddress(dammConfigFor(snap.config), snap.pool.poolState.baseMint, snap.config.quoteMint)
    const migrated = snap.pool.poolState.isMigrated === 1

    const crank = async () => {
        if (!wallet.publicKey) return setVisible(true)
        try {
            setBusy(true)
            const { tx, signers } = await buildMigrateTransaction(connection, snap, wallet.publicKey)
            const [sig] = await sendSteps(connection, wallet, [{ label: 'Graduate to DAMM v2', tx, signers }])
            toast({ kind: 'success', title: 'Graduated to DAMM v2', body: 'The raise and LP tokens now form a live DAMM v2 pool.', href: explorerUrl(network, 'tx', sig) })
            qc.invalidateQueries({ queryKey: ['pool'] })
        } catch (e) {
            toast({ kind: 'error', title: 'Graduation failed', body: explainError(e) })
        } finally {
            setBusy(false)
        }
    }

    return (
        <Card>
            <div className="text-[15px] font-semibold">{migrated ? 'Trading on DAMM v2' : 'Curve complete'}</div>
            <p className="mt-1 text-[13px] text-ink-2">
                {migrated
                    ? `The ${quoteSymbol} raised and the reserved tokens seeded a DAMM v2 pool at exactly the final curve price. LP is split and locked per the preset.`
                    : 'The raise is in. Anyone can graduate the pool: it creates the DAMM v2 pool and splits the LP between the preset author and the creator. Anyone can crank the migration when the configured threshold is met.'}
            </p>
            <div className="mt-3 text-[13px]">
                DAMM v2 pool <Address value={dammPool.toBase58()} network={network} />
            </div>
            {migrated ? (
                network === 'mainnet-beta' && (
                    <a href={`https://www.meteora.ag/dammv2/${dammPool.toBase58()}`} target="_blank" rel="noreferrer">
                        <Button className="mt-4 w-full" variant="primary">
                            Trade on Meteora
                        </Button>
                    </a>
                )
            ) : (
                <Button className="mt-4 w-full" variant="primary" size="lg" onClick={crank} loading={busy}>
                    {wallet.connected ? 'Graduate to DAMM v2' : 'Connect wallet'}
                </Button>
            )}
        </Card>
    )
}

function ClaimBox({ snap, quoteSymbol, quoteDecimals }: { snap: PoolSnapshot; quoteSymbol: string; quoteDecimals: number }) {
    const { connection } = useConnection()
    const wallet = useWallet()
    const { network } = useNetwork()
    const toast = useToast()
    const qc = useQueryClient()
    const [busy, setBusy] = useState<string | null>(null)
    const s = snap.pool.poolState
    const me = wallet.publicKey
    const roles: Array<{ who: 'partner' | 'creator'; label: string; quote: BN; base: BN }> = []
    if (me && snap.config.feeClaimer.equals(me)) roles.push({ who: 'partner', label: 'Preset author', quote: s.partnerQuoteFee, base: s.partnerBaseFee })
    if (me && s.creator.equals(me)) roles.push({ who: 'creator', label: 'Token creator', quote: s.creatorQuoteFee, base: s.creatorBaseFee })
    if (roles.length === 0) return null

    const claim = async (who: 'partner' | 'creator') => {
        try {
            setBusy(who)
            const tx = await buildClaimTransaction(connection, snap, who, me!)
            const [sig] = await sendSteps(connection, wallet, [{ label: 'Claim fees', tx }])
            toast({ kind: 'success', title: 'Fees claimed', href: explorerUrl(network, 'tx', sig) })
            qc.invalidateQueries({ queryKey: ['pool'] })
        } catch (e) {
            toast({ kind: 'error', title: 'Claim failed', body: explainError(e) })
        } finally {
            setBusy(null)
        }
    }

    return (
        <Card>
            <div className="mb-3 text-[15px] font-semibold">Your fees</div>
            <div className="space-y-3">
                {roles.map((r) => (
                    <div key={r.who} className="flex items-center justify-between gap-3">
                        <div>
                            <div className="text-xs text-muted">{r.label}</div>
                            <div className="tnum text-[15px] font-semibold">
                                {num(toUi(r.quote, quoteDecimals))} {quoteSymbol}
                                {!r.base.isZero() && <span className="text-ink-2"> + {num(toUi(r.base, snap.config.tokenDecimal))} tokens</span>}
                            </div>
                        </div>
                        <Button size="sm" onClick={() => claim(r.who)} loading={busy === r.who} disabled={r.quote.isZero() && r.base.isZero()}>
                            Claim
                        </Button>
                    </div>
                ))}
            </div>
        </Card>
    )
}

export function TokenPage() {
    const { pool } = useParams()
    const { network } = useNetwork()
    const snap = usePool(pool)
    const config = snap.data?.configAddress.toBase58()
    const { listing, isLoading: listingLoading } = useListing(config)
    const metas = useTokenMetas(snap.data ? [snap.data.pool.poolState.baseMint] : [])

    const analyzed = useMemo(() => {
        if (!snap.data) return null
        try {
            const spec = specFromConfig(snap.data.config, network, listing?.meta)
            return analyzeConfig(spec, snap.data.config)
        } catch {
            return null
        }
    }, [snap.data?.configAddress.toBase58(), network, listing?.signature])

    if (snap.isLoading) return <Skeleton className="h-96" />
    if (snap.error || !snap.data) return <Empty title="Pool not found">{(snap.error as Error)?.message}</Empty>

    const d = snap.data
    const s = d.pool.poolState
    const qa = quoteAssetByMint(network, d.config.quoteMint)
    if (!qa || !analyzed) return <Empty title="This pool is available for read-only review"><Link className="text-accent hover:underline" to={`/audit/${config}?network=${network}`}>Review the config</Link>. Its quote asset or configuration mode is not supported by this trading interface.</Empty>
    const qSym = qa.symbol
    const qDec = qa.decimals
    const meta = metas.data?.get(s.baseMint.toBase58())
    const raised = toUi(s.quoteReserve, qDec)
    const threshold = toUi(d.config.migrationQuoteThreshold, qDec)
    const complete = s.quoteReserve.gte(d.config.migrationQuoteThreshold)
    const px = getPriceFromSqrtPrice(s.sqrtPrice, d.config.tokenDecimal, qDec).toNumber()
    const supply = analyzed?.spec.token.supply ?? 0

    return (
        <div>
            <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
                <div>
                    <div className="text-[13px] text-muted">
                        Launched from{' '}
                        <Link to={`/p/${config}`} className="font-medium text-ink-2 hover:text-accent">
                            {listing?.meta.n ?? (listingLoading ? '...' : 'a DBC config')}
                        </Link>
                    </div>
                    <h1 className="mt-1 text-3xl font-semibold tracking-tight">
                        {meta?.name ?? 'Token'} <span className="text-ink-2">{meta?.symbol ? `$${meta.symbol}` : ''}</span>
                    </h1>
                    <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 text-[13px] text-muted">
                        <span>
                            Mint <Address value={s.baseMint.toBase58()} network={network} />
                        </span>
                        <span>
                            Pool <Address value={pool!} network={network} />
                        </span>
                        <span>
                            Creator <Address value={s.creator.toBase58()} network={network} />
                        </span>
                    </div>
                </div>
            </div>

            <div className="grid grid-cols-1 gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
                <div className="min-w-0 space-y-5">
                    <Card>
                        <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                            <Stat label="Market cap" value={`${num(px * supply)} ${qSym}`} />
                            <Stat label="Price" value={price(px)} sub={qSym} />
                            <Stat label="Raised" value={`${num(raised)} / ${num(threshold)}`} sub={qSym} />
                            <Stat label="Status" value={s.isMigrated ? 'Graduated' : complete ? 'Ready to graduate' : 'On curve'} />
                        </div>
                        <Progress value={raised / threshold} className="mt-4" />
                        <div className="mt-1.5 text-xs text-muted">{pct(Math.min(100, (raised / threshold) * 100), 1)} of the way to DAMM v2</div>
                    </Card>
                    {analyzed && (
                        <Panel title="Where it is on the curve" hint="The preset's full price path, with this token's current position">
                            <CurveChart a={analyzed} current={{ raised, label: 'now' }} />
                        </Panel>
                    )}
                </div>
                <div className="space-y-5">
                    {complete || s.isMigrated ? <GraduateBox snap={d} quoteSymbol={qSym} /> : <SwapBox snap={d} quoteSymbol={qSym} quoteDecimals={qDec} />}
                    <ClaimBox snap={d} quoteSymbol={qSym} quoteDecimals={qDec} />
                </div>
            </div>
        </div>
    )
}
