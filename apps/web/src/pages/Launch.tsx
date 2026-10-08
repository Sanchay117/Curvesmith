import { useMemo, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useConnection, useWallet } from '@solana/wallet-adapter-react'
import { useWalletModal } from '@solana/wallet-adapter-react-ui'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { PublicKey } from '@solana/web3.js'
import BN from 'bn.js'
import Decimal from 'decimal.js'
import { buildLaunchTransaction, dbcClient, explorerUrl, quoteAssetByMint, SimPool, specFromConfig } from '@launchproof/core'
import { Button, Card, Empty, Field, NumberInput, Skeleton, Stat, TextInput } from '../components/ui'
import { useListing } from '../lib/queries'
import { useNetwork } from '../lib/network'
import { useToast } from '../lib/toast'
import { explainError, sendSteps } from '../lib/tx'
import { bps, num, pct } from '../lib/format'

function defaultMetadataUri() {
    const base = window.location.origin + window.location.pathname.replace(/index\.html$/, '')
    return `${base.endsWith('/') ? base : base + '/'}token-metadata.json`
}

export function Launch() {
    const { config } = useParams()
    const { connection } = useConnection()
    const { network } = useNetwork()
    const wallet = useWallet()
    const { setVisible } = useWalletModal()
    const toast = useToast()
    const navigate = useNavigate()
    const qc = useQueryClient()
    const { listing, isLoading: listingLoading } = useListing(config)

    const poolConfig = useQuery({
        enabled: !!config,
        queryKey: ['rawconfig', network, config],
        queryFn: async () => {
            const pc = await dbcClient(connection).state.getPoolConfig(new PublicKey(config!))
            if (!pc) throw new Error('No DBC config at this address')
            return pc
        },
        retry: false,
    })

    const [name, setName] = useState('')
    const [symbol, setSymbol] = useState('')
    const [uri, setUri] = useState(defaultMetadataUri())
    const [firstBuy, setFirstBuy] = useState(0.05)
    const [busy, setBusy] = useState<string | null>(null)

    const pc = poolConfig.data
    const quote = pc ? (quoteAssetByMint(network, pc.quoteMint) ?? { symbol: 'quote', decimals: 9 }) : null
    const spec = useMemo(() => (pc ? specFromConfig(pc, network, listing?.meta) : null), [pc, network, listing])

    // exact preview of the bundled first buy on a fresh pool
    const preview = useMemo(() => {
        if (!pc || !quote || firstBuy <= 0) return null
        try {
            const now = Math.floor(Date.now() / 1000)
            const sim = new SimPool(pc, { startTime: now })
            const amountIn = new BN(new Decimal(firstBuy).mul(new Decimal(10).pow(quote.decimals)).floor().toFixed())
            const r = sim.quote({ side: 'buy', amountIn, mode: 'partial-fill', bundledWithCreate: true }, now)
            const tokens = new Decimal(r.outputAmount.toString()).div(new Decimal(10).pow(pc.tokenDecimal)).toNumber()
            const fee = r.tradingFee.add(r.protocolFee)
            return {
                tokens,
                supplyPct: spec ? (tokens / spec.token.supply) * 100 : 0,
                feeBps: amountIn.isZero() ? 0 : (fee.toNumber() / amountIn.toNumber()) * 10_000,
            }
        } catch {
            return null
        }
    }, [pc, quote, firstBuy, spec])

    if (poolConfig.isLoading) return <Skeleton className="h-96" />
    if (poolConfig.error || !pc || !quote || !spec) return <Empty title="Preset not found">{(poolConfig.error as Error)?.message}</Empty>

    const valid = name.trim().length > 0 && name.length <= 32 && symbol.trim().length > 0 && symbol.length <= 10 && /^https?:\/\//.test(uri)

    const launch = async () => {
        if (!wallet.publicKey) return setVisible(true)
        try {
            setBusy('Building...')
            const amount = firstBuy > 0 ? new BN(new Decimal(firstBuy).mul(new Decimal(10).pow(quote.decimals)).floor().toFixed()) : undefined
            const { tx, baseMint, pool } = await buildLaunchTransaction(connection, {
                config: new PublicKey(config!),
                creator: wallet.publicKey,
                name: name.trim(),
                symbol: symbol.trim().toUpperCase(),
                uri: uri.trim(),
                firstBuy: amount,
            })
            const [sig] = await sendSteps(connection, wallet, [{ label: 'Launch token', tx, signers: [baseMint] }], (_, l, s) =>
                setBusy(s ? 'Confirmed' : `${l}...`)
            )
            toast({ kind: 'success', title: `${symbol.toUpperCase()} is live`, body: 'Your token is trading on its bonding curve.', href: explorerUrl(network, 'tx', sig) })
            qc.invalidateQueries({ queryKey: ['stats'] })
            navigate(`/token/${pool.toBase58()}`)
        } catch (e) {
            toast({ kind: 'error', title: 'Launch failed', body: explainError(e) })
        } finally {
            setBusy(null)
        }
    }

    const creationFee = pc.poolCreationFee.toNumber() / 1e9

    return (
        <div className="mx-auto max-w-3xl">
            <Link to={`/p/${config}`} className="text-[13px] text-muted hover:text-ink">
                Back to preset
            </Link>
            <h1 className="mt-2 text-3xl font-semibold tracking-tight">Launch a token</h1>
            <p className="mt-1 text-[14px] text-ink-2">
                Using <span className="font-semibold text-ink">{listing?.meta.n ?? (listingLoading ? '...' : 'this DBC config')}</span>. The curve, fees and graduation terms are fixed by
                the preset; you choose the token.
            </p>

            <Card className="mt-6">
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
                    <Stat label="Graduation raise" value={`${num(new Decimal(pc.migrationQuoteThreshold.toString()).div(new Decimal(10).pow(quote.decimals)).toNumber())} ${quote.symbol}`} />
                    <Stat label="Opening fee" value={bps(spec.fees.schedule.startBps)} sub={spec.fees.schedule.startBps !== spec.fees.schedule.endBps ? `settles at ${bps(spec.fees.schedule.endBps)}` : 'flat'} />
                    <Stat label="Your share of fees" value={`${spec.fees.creatorSharePct}%`} sub="of trading fees" />
                    <Stat label="Launch cost" value={creationFee ? `${num(creationFee)} SOL` : 'free'} sub="plus ~0.03 SOL rent" />
                </div>
            </Card>

            <Card className="mt-5 space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                    <Field label="Token name" hint={`${name.length}/32`}>
                        <TextInput value={name} maxLength={32} placeholder="e.g. Proof Cat" onChange={(e) => setName(e.target.value)} />
                    </Field>
                    <Field label="Symbol" hint={`${symbol.length}/10`}>
                        <TextInput value={symbol} maxLength={10} placeholder="CAT" onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
                    </Field>
                </div>
                <Field label="Metadata URI" hint="Metaplex JSON: name, symbol, image">
                    <TextInput value={uri} onChange={(e) => setUri(e.target.value)} />
                </Field>
                <Field label={`First buy (${quote.symbol})`} hint={spec.fees.firstSwapMinFee ? 'bundled in the same transaction at the minimum fee' : 'bundled in the same transaction'}>
                    <NumberInput value={firstBuy} suffix={quote.symbol} step={0.01} onChange={(v) => setFirstBuy(Math.max(0, v))} />
                </Field>
                {preview && (
                    <div className="rounded-xl bg-surface-2 px-4 py-3 text-[13px] text-ink-2">
                        You receive about <span className="tnum font-semibold text-ink">{num(preview.tokens)}</span> tokens (
                        {pct(preview.supplyPct, 2)} of supply), paying a <span className="font-semibold text-ink">{bps(preview.feeBps)}</span> fee.
                    </div>
                )}
                <div className="flex justify-end">
                    <Button variant="primary" size="lg" onClick={launch} loading={!!busy} disabled={wallet.connected && !valid}>
                        {busy ?? (wallet.connected ? 'Launch token' : 'Connect wallet')}
                    </Button>
                </div>
            </Card>
        </div>
    )
}
