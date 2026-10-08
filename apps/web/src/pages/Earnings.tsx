import { ReactNode, useState } from 'react'
import { Link } from 'react-router-dom'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import { buildClaimTransaction, explorerUrl, Listing, PoolSnapshot, poolsByCreator, quoteAssetByMint, summarizePool } from '@launchproof/core'
import Decimal from 'decimal.js'
import { Button, Card, Empty, Skeleton } from '../components/ui'
import { CountUp, Reveal } from '../components/motion'
import { statsQuery, useListings } from '../lib/queries'
import { useNetwork } from '../lib/network'
import { listingSpec } from '../lib/evaluations'
import { useToast } from '../lib/toast'
import { explainError, sendSteps } from '../lib/tx'
import { num } from '../lib/format'

interface Row {
    snap: PoolSnapshot
    who: 'partner' | 'creator'
    preset: string
    quote: number
    base: number
    quoteSymbol: string
}

function ClaimTable({ rows, title, empty, hint }: { rows: Row[]; title: string; empty: string; hint: ReactNode }) {
    const { connection } = useConnection()
    const wallet = useWallet()
    const { network } = useNetwork()
    const toast = useToast()
    const qc = useQueryClient()
    const [busy, setBusy] = useState<string | null>(null)
    const claimable = rows.filter((r) => r.quote > 0 || r.base > 0)

    const claim = async (rs: Row[]) => {
        try {
            setBusy(rs.length > 1 ? 'all' : rs[0].snap.address.toBase58())
            const steps = []
            for (const r of rs) steps.push({ label: `Claim ${r.preset}`, tx: await buildClaimTransaction(connection, r.snap, r.who, wallet.publicKey!) })
            const sigs = await sendSteps(connection, wallet, steps)
            toast({ kind: 'success', title: `Claimed from ${sigs.length} pool${sigs.length > 1 ? 's' : ''}`, href: explorerUrl(network, 'tx', sigs[sigs.length - 1]) })
            qc.invalidateQueries({ queryKey: ['stats'] })
            qc.invalidateQueries({ queryKey: ['creatorPools'] })
        } catch (e) {
            toast({ kind: 'error', title: 'Claim failed', body: explainError(e) })
        } finally {
            setBusy(null)
        }
    }

    const totals = claimable.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.quoteSymbol]: (acc[r.quoteSymbol] ?? 0) + r.quote }), {})

    return (
        <section className="mb-10">
            <div className="mb-3 flex flex-wrap items-end justify-between gap-3">
                <div>
                    <h2 className="text-xl font-semibold">{title}</h2>
                    <div className="mt-0.5 text-[13px] text-muted">
                        Claimable now:{' '}
                        {Object.keys(totals).length
                            ? Object.entries(totals).map(([k, v], i) => (
                                  <span key={k}>
                                      {i > 0 && ' + '}
                                      <CountUp value={v} format={(n) => `${num(n)} ${k}`} />
                                  </span>
                              ))
                            : 'nothing yet'}
                    </div>
                </div>
                {claimable.length > 1 && (
                    <Button variant="primary" onClick={() => claim(claimable.slice(0, 6))} loading={busy === 'all'}>
                        Claim all{claimable.length > 6 ? ' (first 6)' : ''}
                    </Button>
                )}
            </div>
            {rows.length === 0 ? (
                <Empty title={empty}>{hint}</Empty>
            ) : (
                <ul className="space-y-2">
                    {rows.map((r, i) => (
                        <Reveal key={r.snap.address.toBase58() + r.who} as="li" delay={Math.min(i, 6) * 60}>
                            <Card pad={false} className="lp-lift flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                                <div className="min-w-0">
                                    <Link className="font-mono text-[13px] hover:text-accent" to={`/token/${r.snap.address.toBase58()}`}>
                                        {r.snap.address.toBase58().slice(0, 8)}...
                                    </Link>
                                    <div className="text-[13px] text-muted">{r.preset}</div>
                                </div>
                                <div className="flex items-center gap-4">
                                    <div className="tnum text-right text-[14px] font-semibold">
                                        {num(r.quote)} {r.quoteSymbol}
                                        {r.base > 0 && <div className="text-[12px] font-normal text-ink-2">+ {num(r.base)} tokens</div>}
                                    </div>
                                    <Button
                                        size="sm"
                                        disabled={r.quote === 0 && r.base === 0}
                                        loading={busy === r.snap.address.toBase58()}
                                        onClick={() => claim([r])}
                                    >
                                        Claim
                                    </Button>
                                </div>
                            </Card>
                        </Reveal>
                    ))}
                </ul>
            )}
        </section>
    )
}

export function Earnings() {
    const wallet = useWallet()
    const { setVisible } = useWalletModal()
    const { connection } = useConnection()
    const { network, rpcUrl } = useNetwork()
    const listings = useListings()
    const me = wallet.publicKey

    const mine: Listing[] = (listings.data ?? []).filter((l) => me && l.author.equals(me))
    const stats = useQueries({ queries: mine.map((l) => statsQuery(connection, network, rpcUrl, l)) })
    const created = useQuery({
        enabled: !!me,
        queryKey: ['creatorPools', network, rpcUrl, me?.toBase58()],
        queryFn: () => poolsByCreator(connection, me!),
    })

    if (!me) {
        return (
            <Reveal className="mx-auto max-w-xl py-16 text-center">
                <h1 className="text-3xl font-semibold tracking-tight">Earnings</h1>
                <p className="mt-2 text-ink-2">Connect a wallet to see the fees you can claim.</p>
                <Button className="mt-6" variant="primary" size="lg" onClick={() => setVisible(true)}>
                    Connect wallet
                </Button>
            </Reveal>
        )
    }

    const authorRows: Row[] = []
    mine.forEach((l, i) => {
        const st = stats[i]?.data
        if (!st) return
        const sym = listingSpec(l, network).quote
        st.snapshots.forEach((snap, j) => {
            const c = st.pools.find((p) => p.pool.equals(snap.address)) ?? st.pools[j]
            authorRows.push({ snap, who: 'partner', preset: l.meta.n, quote: c.claimable.partnerQuote, base: c.claimable.partnerBase, quoteSymbol: sym })
        })
    })

    const creatorRows: Row[] = (created.data ?? []).map((snap) => {
        const qa = quoteAssetByMint(network, snap.config.quoteMint)
        const supply = new Decimal(snap.config.preMigrationTokenSupply.toString()).div(new Decimal(10).pow(snap.config.tokenDecimal)).toNumber()
        const sum = summarizePool(snap.address, snap.pool, snap.config, qa?.decimals ?? 0, supply)
        const l = listings.data?.find((x) => x.config.equals(snap.configAddress))
        return { snap, who: 'creator', preset: l?.meta.n ?? 'Unlisted config', quote: sum.claimable.creatorQuote, base: sum.claimable.creatorBase, quoteSymbol: qa?.symbol ?? 'raw quote units' }
    })

    const loading = listings.isLoading || stats.some((s) => s.isLoading) || created.isLoading

    return (
        <div>
            <Reveal>
                <h1 className="text-3xl font-semibold tracking-tight">Earnings</h1>
                <p className="mt-1 mb-8 text-[14px] text-ink-2">Authors earn the partner share of every trade on their launches. Creators earn their share of their own token's fees.</p>
            </Reveal>
            {loading ? (
                <Skeleton className="h-64" />
            ) : (
                <>
                    <Reveal delay={80}>
                        <ClaimTable
                            rows={authorRows}
                            title={`As preset author (${mine.length} preset${mine.length === 1 ? '' : 's'})`}
                            empty="No launches on your presets yet"
                            hint={
                                <>
                                    Publish a preset and each launch on it pays you here. <Link to="/studio" className="font-semibold text-accent hover:underline">Open the Studio</Link>
                                </>
                            }
                        />
                    </Reveal>
                    <Reveal delay={160}>
                        <ClaimTable
                            rows={creatorRows}
                            title="As token creator"
                            empty="You have not launched a token yet"
                            hint={
                                <>
                                    Launch from any preset and your creator share shows up here. <Link to="/market" className="font-semibold text-accent hover:underline">Browse presets</Link>
                                </>
                            }
                        />
                    </Reveal>
                </>
            )}
        </div>
    )
}
