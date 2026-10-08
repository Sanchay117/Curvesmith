import { useMemo } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Connection, PublicKey } from '@solana/web3.js'
import { createDbcProgram, PoolConfig } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { unpackMint, TOKEN_2022_PROGRAM_ID, TOKEN_PROGRAM_ID } from '@solana/spl-token'
import { auditConfig, AuditReceipt, DBC_PROGRAM_ID, explorerUrl, sha256, toHex } from '@launchproof/core'
import { useNetwork } from '../lib/network'
import { Button, Card, Empty, Skeleton } from '../components/ui'
import { CountUp, Reveal, RingMeter } from '../components/motion'
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
    const flagged = audit?.findings.filter((f) => f.severity === 'critical' || f.severity === 'warning') ?? []
    const worst = flagged.some((f) => f.severity === 'critical') ? 'var(--critical)' : flagged.length ? 'var(--serious)' : 'var(--muted)'
    return (
        <div className="mx-auto max-w-4xl">
            <Link to="/" className="text-sm text-muted transition-colors hover:text-accent">
                ← State of DBC
            </Link>
            <div className="mt-6 flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0">
                    <div className="text-xs font-semibold tracking-widest text-accent uppercase">Config audit · {network === 'devnet' ? 'devnet' : 'mainnet'}</div>
                    <a href={explorerUrl(network, 'address', address)} target="_blank" rel="noreferrer" className="mt-2 block font-mono text-2xl font-semibold break-all hover:text-accent sm:text-3xl">
                        {address.slice(0, 6)}...{address.slice(-6)} <span className="text-base text-muted">↗</span>
                    </a>
                </div>
                <div className="flex gap-2">
                    <Button size="sm" onClick={() => live.refetch()} disabled={live.isFetching}>
                        {live.isFetching ? 'Reading...' : 'Refresh'}
                    </Button>
                    <Button size="sm" disabled={!live.data} onClick={download}>
                        Receipt ↓
                    </Button>
                </div>
            </div>
            {live.error && (
                <p role="status" className="mt-4 text-sm text-serious">
                    Live read failed. {cached?.audit ? 'Showing the census snapshot instead.' : 'Check the address and network.'}
                </p>
            )}
            {!audit && live.isLoading && <Skeleton className="mt-6 h-64" />}
            {!audit && !live.isLoading && (
                <div className="mt-6">
                    <Empty title="No DBC config here">Paste a config address, not a pool or token mint.</Empty>
                </div>
            )}
            {audit && (
                <>
                    {/* verdict */}
                    <div className="lp-pop mt-6 flex items-center gap-4 rounded-2xl border p-5" style={{ borderColor: `color-mix(in srgb, ${worst} 45%, transparent)`, background: `color-mix(in srgb, ${worst} 8%, transparent)` }}>
                        <div className="grid size-12 shrink-0 place-items-center rounded-xl text-xl font-bold text-white" style={{ background: worst }}>
                            {flagged.length || 'i'}
                        </div>
                        <div>
                            <div className="text-lg font-semibold">{flagged.length ? `${flagged.length} ${flagged.length === 1 ? 'term' : 'terms'} to read before you buy` : 'No flagged terms'}</div>
                            <div className="text-sm text-ink-2">{flagged.length ? flagged.map((f) => f.title).join(' · ') : 'No configured term tripped a finding.'} Seven term checks run; this is not a safety certificate.</div>
                        </div>
                    </div>

                    {/* the two numbers that matter most, then the rest */}
                    <div className="mt-4 grid gap-4 sm:grid-cols-2">
                        {[
                            { label: 'of graduated liquidity can be pulled on day one', value: audit.unlockedLiquidityPct / 100, warn: audit.unlockedLiquidityPct > 50 },
                            { label: 'of supply left to one wallet after graduation', value: audit.leftoverSupplyPct / 100, warn: audit.leftoverSupplyPct > 5 },
                        ].map((m, n) => (
                            <Reveal key={m.label} delay={n * 120}>
                                <Card className="flex items-center gap-5">
                                    <RingMeter value={m.value} color={m.warn ? (m.value > 0.5 ? 'var(--critical)' : 'var(--serious)') : 'var(--good)'} size={96}>
                                        <CountUp value={m.value * 100} format={(v) => `${v.toFixed(0)}%`} className="text-lg font-semibold" />
                                    </RingMeter>
                                    <div className="text-[15px] leading-snug font-medium">{m.label}</div>
                                </Card>
                            </Reveal>
                        ))}
                    </div>
                    <Reveal>
                        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
                            {[
                                ['Raise', audit.raise === null ? 'raw units' : `${num(Number(audit.raise))} ${audit.quoteSymbol ?? ''}`],
                                ['Graduates to', audit.migration],
                                ['Opening fee', `${(audit.openingFeeBps / 100).toFixed(2)}%`],
                                ['Price range', `${num(audit.priceMultiple)}x`],
                            ].map(([label, value]) => (
                                <div key={label} className="rounded-xl border border-line bg-surface px-4 py-3">
                                    <div className="text-xs text-muted">{label}</div>
                                    <div className="mt-1 font-semibold">{value}</div>
                                </div>
                            ))}
                        </div>
                    </Reveal>
                    {!audit.quoteSymbol && (
                        <p className="mt-3 text-xs text-muted">
                            Custom quote mint{' '}
                            <a href={explorerUrl(network, 'address', audit.quoteMint)} target="_blank" rel="noreferrer" className="font-mono text-accent hover:underline">
                                {audit.quoteMint.slice(0, 6)}...{audit.quoteMint.slice(-4)}
                            </a>
                            : amounts are in its own units, not SOL or USD.
                        </p>
                    )}

                    {/* findings */}
                    <h2 className="mt-10 text-xl font-semibold">What the config allows</h2>
                    <div className="mt-4 space-y-3">
                        {audit.findings.map((f, n) => {
                            const color = f.severity === 'critical' ? 'var(--critical)' : f.severity === 'warning' ? 'var(--serious)' : 'var(--s1)'
                            return (
                                <Reveal key={f.id} delay={n * 90}>
                                    <div className="rounded-2xl border border-line border-l-4 bg-surface p-4" style={{ borderLeftColor: color }}>
                                        <div className="flex items-center gap-3">
                                            <h3 className="font-semibold">{f.title}</h3>
                                            <span className="ml-auto rounded-full px-2 py-0.5 text-[11px] font-medium" style={{ color, background: `color-mix(in srgb, ${color} 14%, transparent)` }}>
                                                {f.severity}
                                            </span>
                                        </div>
                                        <p className="mt-1.5 text-sm leading-relaxed text-ink-2">{f.detail}</p>
                                    </div>
                                </Reveal>
                            )
                        })}
                    </div>

                    <details className="group mt-8 rounded-2xl border border-line bg-surface p-4 [&_summary::-webkit-details-marker]:hidden">
                        <summary className="flex cursor-pointer list-none items-center justify-between text-sm">
                            <span className="font-medium">Evidence and receipt</span>
                            <span className="text-muted transition-transform group-open:rotate-180">⌄</span>
                        </summary>
                        <div className="mt-3 space-y-2 border-t border-line pt-3 text-xs leading-relaxed text-ink-2">
                            <p>{live.data ? `Read live at finalized slot ${live.data.slot}.` : `From the census snapshot of ${census.data?.observedAt ?? 'mainnet'}.`} Policy {audit.policy}. The receipt holds the raw config bytes and their hash, so anyone can re-run this review offline. It is an RPC observation, not an endorsement.</p>
                            <div className="font-mono break-all text-muted">SHA-256 {live.data?.configHash ?? cached?.configHash}</div>
                            <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3">pnpm cli verify-receipt launchproof-{address}.json</pre>
                        </div>
                    </details>

                    <div className="mt-8 flex flex-wrap gap-3">
                        <Link to="/studio">
                            <Button variant="primary">Design a better config</Button>
                        </Link>
                        <Link to="/market">
                            <Button>Browse presets</Button>
                        </Link>
                    </div>
                </>
            )}
        </div>
    )
}
