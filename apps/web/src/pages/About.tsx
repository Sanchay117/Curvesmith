import { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { REGISTRY_ADDRESS } from '@curvesmith/core'
import { Card } from '../components/ui'

function Step({ n, title, children }: { n: number; title: string; children: ReactNode }) {
    return (
        <div className="flex gap-4">
            <div className="grid size-8 shrink-0 place-items-center rounded-full bg-accent-wash text-sm font-semibold text-accent">{n}</div>
            <div>
                <div className="text-[15px] font-semibold">{title}</div>
                <div className="mt-1 text-[14px] leading-relaxed text-ink-2">{children}</div>
            </div>
        </div>
    )
}

function Flow() {
    const boxes = [
        { x: 0, label: 'PresetSpec', sub: 'shape, mcaps, fees, LP' },
        { x: 1, label: 'Curve compiler', sub: '16-segment DBC curve' },
        { x: 2, label: 'Simulator + lint', sub: 'exact program math' },
        { x: 3, label: 'create_config', sub: 'you are the partner' },
        { x: 4, label: 'CSR-1 listing', sub: 'memo + registry ref' },
    ]
    const W = 168
    const G = 28
    return (
        <svg viewBox={`0 0 ${boxes.length * W + (boxes.length - 1) * G} 86`} className="w-full" role="img" aria-label="Pipeline from preset spec to on-chain listing">
            <defs>
                <marker id="arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
                    <path d="M0 0L8 4L0 8z" fill="var(--muted)" />
                </marker>
            </defs>
            {boxes.map((b, i) => {
                const x = i * (W + G)
                return (
                    <g key={b.label}>
                        <rect x={x} y={8} width={W} height={64} rx={12} fill="var(--surface-2)" stroke="var(--border-strong)" />
                        <text x={x + W / 2} y={36} textAnchor="middle" fontSize="14" fontWeight="600" fill="var(--ink)">
                            {b.label}
                        </text>
                        <text x={x + W / 2} y={55} textAnchor="middle" fontSize="11.5" fill="var(--muted)">
                            {b.sub}
                        </text>
                        {i < boxes.length - 1 && <line x1={x + W + 4} y1={40} x2={x + W + G - 4} y2={40} stroke="var(--muted)" strokeWidth="1.5" markerEnd="url(#arrow)" />}
                    </g>
                )
            })}
        </svg>
    )
}

export function About() {
    return (
        <div className="mx-auto max-w-3xl">
            <h1 className="text-4xl font-semibold tracking-tight">How Curvesmith works</h1>
            <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
                Meteora's Dynamic Bonding Curve (DBC) lets a token discover its price on a configurable curve, then graduate into a DAMM v2 pool once a
                raise is met. A DBC <em>config</em> fixes everything about that launch: up to 16 curve segments, fee schedules, who owns the graduated
                liquidity. Today those configs are ~40 raw numbers that each launchpad hand-tunes and deploys blind. Curvesmith turns them into designed,
                tested, shareable products.
            </p>

            <Card className="mt-8">
                <Flow />
            </Card>

            <div className="mt-10 space-y-7">
                <Step n={1} title="Design with shapes, not sqrt prices">
                    Pick a price path (constant product, linear, exponential, power, S-curve, flat, tranches or freehand) and market caps. The compiler
                    places up to 16 breakpoints on that path and solves each segment's liquidity so it sells exactly its slice of the sale. Because DBC
                    graduates at the last breakpoint, the DAMM v2 pool always opens at the final curve price, with no gap.
                </Step>
                <Step n={2} title="Simulate against a market, with the program's own math">
                    Swaps are quoted by the official DBC SDK, which mirrors the program's fixed-point arithmetic, and the post-swap state transition
                    (reserves, fee buckets, the dynamic-fee volatility tracker) is ported from the Rust program. Scenarios replay snipers, crowds, whales
                    and panics with seeded randomness, so results are reproducible and comparable across presets.
                </Step>
                <Step n={3} title="Verified against the real program binary">
                    The test suite loads Meteora's DBC and DAMM v2 programs into LiteSVM (an in-process Solana VM), creates configs, and replays random
                    trade sequences on both the simulator and the real program, asserting identical price, reserves and fees after every swap. It also
                    runs a full launch through graduation into a real DAMM v2 pool and checks the predicted pool amounts.
                </Step>
                <Step n={4} title="Review before you publish">
                    The lint pass runs the SDK's protocol validation (what the chain would reject) and economic checks the chain happily accepts but
                    traders pay for: no sniper tax, unlocked LP, thin graduated pools, retained mint authority, value skimmed at graduation. Findings from
                    simulation (sniper ROI, graduation time) feed a 0-100 launch health score.
                </Step>
                <Step n={5} title="Publish: your preset becomes your launchpad">
                    Publishing creates a DBC config whose fee claimer is your wallet. Every token launched from it pays you the partner share of its
                    trading fees, a share of graduation fees, and the graduated LP you configured. No custom program, no server, no permission.
                </Step>
                <Step n={6} title="An on-chain registry with no indexer (CSR-1)">
                    A listing is a transaction with an SPL Memo <code className="font-mono text-[13px]">csr1:{'{...}'}</code> and a 0-lamport transfer to
                    the registry address <code className="font-mono text-[13px] break-all">{REGISTRY_ADDRESS.toBase58()}</code>, which is{' '}
                    <code className="font-mono text-[13px]">sha256("curvesmith:registry:v1")</code>, so nobody holds its key. Clients enumerate the
                    marketplace with <code className="font-mono text-[13px]">getSignaturesForAddress</code>. Economics are never read from the memo: each
                    listing is joined with the real config account, and kept only if the signer is that config's fee claimer.
                </Step>
                <Step n={7} title="Launch, trade, graduate, claim">
                    Creators launch from any preset with a bundled first buy. Traders get exact quotes from the same simulator. When the raise is met,
                    anyone can crank graduation into DAMM v2 from the token page, and authors and creators claim fees from Earnings.
                </Step>
            </div>

            <Card className="mt-10">
                <div className="text-[15px] font-semibold">For developers and agents</div>
                <p className="mt-1 text-[14px] leading-relaxed text-ink-2">
                    Everything here is a TypeScript library, <code className="font-mono text-[13px]">@curvesmith/core</code>, used unchanged by this app, a
                    CLI, and an MCP server that lets AI agents design, simulate, review and build transactions for DBC launches. See the repository README.
                </p>
                <Link to="/studio" className="mt-3 inline-block text-[14px] font-semibold text-accent hover:underline">
                    Open the Studio
                </Link>
            </Card>
        </div>
    )
}
