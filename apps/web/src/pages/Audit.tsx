import { useMemo } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Connection, PublicKey } from '@solana/web3.js'
import { createDbcProgram, PoolConfig } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { unpackMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { auditConfig, AuditReceipt, DBC_PROGRAM_ID, explorerUrl, sha256, toHex } from '@launchproof/core'
import { useNetwork } from '../lib/network'
import { Button, Card, Empty, Skeleton } from '../components/ui'
import { num } from '../lib/format'
import { useCensus } from './Report'

export function Audit() {
    const { address = '' } = useParams()
    const [search] = useSearchParams()
    const userNetwork = useNetwork()
    const network = search.get('network') === 'devnet' ? 'devnet' : 'mainnet-beta'
    const rpc = userNetwork.network === network ? userNetwork.rpcUrl : network === 'devnet' ? 'https://api.devnet.solana.com' : 'https://solana-rpc.publicnode.com'
    const connection = useMemo(() => new Connection(rpc, 'finalized'), [rpc])
    const census = useCensus()
    const cached = network === 'mainnet-beta' ? census.data?.rows.find((r) => r.address === address) : undefined
    const live = useQuery({
        queryKey: ['audit', network, rpc, address], retry: false, staleTime: 60_000,
        queryFn: async () => {
            const key = new PublicKey(address)
            const result = await connection.getAccountInfoAndContext(key, 'finalized')
            if (!result.value || !result.value.owner.equals(DBC_PROGRAM_ID)) throw new Error('No DBC-owned config at this address')
            const { program } = createDbcProgram(connection)
            const config = program.coder.accounts.decode('poolConfig', result.value.data) as PoolConfig
            let decimals: number | undefined
            let quoteMintAccount: AuditReceipt['quoteMintAccount']
            try {
                const mint = await connection.getAccountInfo(config.quoteMint)
                if (mint && (mint.owner.equals(TOKEN_PROGRAM_ID) || mint.owner.equals(TOKEN_2022_PROGRAM_ID))) {
                    decimals = unpackMint(config.quoteMint, mint, mint.owner).decimals
                    quoteMintAccount = { data: mint.data.toString('base64'), owner: mint.owner.toBase58() }
                }
            } catch { /* Raw amounts remain available when the mint read fails. */ }
            return {
                schema: 'launchproof/audit-receipt@1', address, network, slot: result.context.slot,
                fetchedAt: new Date().toISOString(), configHash: toHex(sha256(result.value.data)),
                configData: result.value.data.toString('base64'), audit: auditConfig(config, network, decimals),
                quoteMintAccount,
            }
        },
    })
    const audit = live.data?.audit ?? cached?.audit
    function download() {
        if (!live.data) return
        const url = URL.createObjectURL(new Blob([JSON.stringify(live.data, null, 2)], { type: 'application/json' }))
        const a = document.createElement('a')
        a.href = url; a.download = `launchproof-${address}.json`; a.click(); URL.revokeObjectURL(url)
    }
    return <div className="mx-auto max-w-4xl"><Link to="/report" className="text-sm text-accent hover:underline">← State of DBC</Link>
        <div className="mt-5 text-xs font-semibold tracking-widest text-accent uppercase">Configuration review · {network}</div><h1 className="mt-3 text-4xl font-semibold tracking-tight">Know what the config permits.</h1>
        <a href={explorerUrl(network, 'address', address)} target="_blank" rel="noreferrer" className="mt-4 block break-all font-mono text-sm text-ink-2 hover:text-accent">{address} ↗</a>
        <div className="mt-5 flex flex-wrap gap-2"><Button onClick={() => live.refetch()} disabled={live.isFetching}>{live.isFetching ? 'Reading finalized account…' : 'Refresh from chain'}</Button><Button disabled={!live.data} onClick={download}>Download audit receipt ↓</Button></div>
        {live.error && <p role="status" className="mt-4 text-sm text-serious">Live read failed: {(live.error as Error).message}. {cached?.audit ? 'Showing the dated report snapshot below.' : 'Check the address, network, or RPC setting.'}</p>}
        {!audit && live.isLoading && <Skeleton className="mt-6 h-64" />}
        {!audit && !live.isLoading && <div className="mt-6"><Empty title="No review available">A decoded DBC PoolConfig is required. Pool and token mint addresses are different from config addresses.</Empty></div>}
        {audit && <>
            <p className="mt-5 text-xs text-muted">{live.data ? `Live account · finalized slot ${live.data.slot} · ${live.data.fetchedAt}` : `Snapshot · ${census.data?.observedAt}`} · Policy {audit.policy}</p>
            <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{[
                ['Configured raise', audit.raise === null ? `${audit.raiseRaw} raw units` : `${num(Number(audit.raise))} ${audit.quoteSymbol ?? 'quote tokens'}`],
                ['Migration target', audit.migration], ['Initially unlocked LP', `${audit.unlockedLiquidityPct}%`],
                ['Opening base fee', `${(audit.openingFeeBps / 100).toFixed(2)}%`], ['Residual supply estimate', `${audit.leftoverSupplyPct.toFixed(2)}%`],
                ['Price range', `${num(audit.priceMultiple)}×`],
            ].map(([label, value]) => <Card key={label}><div className="text-xs text-muted">{label}</div><div className="mt-2 text-xl font-semibold">{value}</div></Card>)}</div>
            <Card className="mt-4"><div className="text-xs font-medium text-muted">QUOTE MINT · {audit.quoteDecimals === null ? 'precision unresolved' : `${audit.quoteDecimals} decimals`}</div><a href={explorerUrl(network, 'address', audit.quoteMint)} target="_blank" rel="noreferrer" className="mt-2 block break-all font-mono text-sm text-accent hover:underline">{audit.quoteMint} ↗</a>{!audit.quoteSymbol && <p className="mt-2 text-sm text-ink-2">Custom quote asset. These amounts are not labeled SOL or USD. No monetary value is inferred.</p>}</Card>
            <h2 className="mt-8 text-2xl font-semibold">Terms to review</h2><div className="mt-4 space-y-3">{audit.findings.map((f) => <Card key={f.id}><div className="flex items-center gap-3"><span className={f.severity === 'critical' ? 'text-critical' : f.severity === 'warning' ? 'text-serious' : 'text-muted'}>●</span><h3 className="font-semibold">{f.title}</h3><span className="ml-auto text-xs text-muted">{f.severity}</span></div><p className="mt-2 text-sm leading-relaxed text-ink-2">{f.detail}</p></Card>)}{!audit.findings.length && <Card>No terms were flagged by these checks. That is not a safety certification.</Card>}</div>
            <Card className="mt-8"><h2 className="font-semibold">Evidence and scope</h2><p className="mt-2 text-sm leading-relaxed text-ink-2">The receipt records the decoded config, its account-byte hash, observation slot, and deterministic review policy. It is an RPC observation, not a cryptographic proof of chain inclusion or an endorsement. It does not inspect issuer identity, backing, holder concentration, trading history, or future behavior.</p><div className="mt-4 break-all font-mono text-xs text-muted">SHA-256 {live.data?.configHash ?? cached?.configHash}</div><pre className="mt-4 overflow-x-auto text-xs">pnpm cli verify-receipt launchproof-{address}.json</pre></Card>
            <div className="mt-6 flex flex-wrap gap-3"><Link to="/studio"><Button variant="primary">Design your own config</Button></Link><Link to="/market"><Button>Explore templates</Button></Link></div>
        </>}
    </div>
}
