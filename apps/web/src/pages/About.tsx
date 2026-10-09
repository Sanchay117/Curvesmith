import { Fragment, ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { REGISTRY_ADDRESS } from '@launchproof/core'
import { Card, cx } from '../components/ui'
import { Reveal } from '../components/motion'

function Step({ n, title, delay, className, children }: { n: number; title: string; delay: number; className?: string; children: ReactNode }) {
    return (
        <Reveal delay={delay} className={cx('h-full', className)}>
            <Card className="lp-lift h-full">
                <div className="flex items-center gap-3">
                    <div className="tnum grid size-7 shrink-0 place-items-center rounded-full bg-accent-wash text-xs font-semibold text-accent">{n}</div>
                    <h2 className="text-[15px] font-semibold">{title}</h2>
                </div>
                <div className="mt-3 text-[14px] leading-relaxed text-ink-2">{children}</div>
            </Card>
        </Reveal>
    )
}

function Flow() {
    const boxes = [
        { label: 'PresetSpec', sub: 'shape, mcaps, fees, LP' },
        { label: 'Curve compiler', sub: '16-segment DBC curve' },
        { label: 'Simulator + lint', sub: 'SDK quote math' },
        { label: 'create_config', sub: 'you are the partner' },
        { label: 'CSR-1 listing', sub: 'memo + registry ref' },
    ]
    return (
        <div role="group" aria-label="Pipeline from preset spec to on-chain listing" className="flex flex-col gap-2 md:flex-row md:items-center">
            {boxes.map((b, i) => (
                <Fragment key={b.label}>
                    <div className="lp-pop rounded-xl border border-line-strong bg-surface-2 px-3 py-3 text-center md:flex-1" style={{ animationDelay: `${i * 150}ms` }}>
                        <div className="text-[14px] font-semibold">{b.label}</div>
                        <div className="mt-0.5 text-[12px] text-muted">{b.sub}</div>
                    </div>
                    {i < boxes.length - 1 && (
                        <svg
                            aria-hidden
                            viewBox="0 0 24 24"
                            className="lp-pop mx-auto size-5 shrink-0 rotate-90 text-muted md:mx-2 md:rotate-0"
                            style={{ animationDelay: `${i * 150 + 75}ms` }}
                        >
                            <path d="M4 12h14M13 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                    )}
                </Fragment>
            ))}
        </div>
    )
}

export function About() {
    return (
        <div className="mx-auto max-w-3xl">
            <Reveal>
                <h1 className="text-4xl font-semibold tracking-tight">From configuration evidence to a working launch</h1>
                <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
                    Start with the State of DBC report or paste a config into the auditor, then reproduce its review offline. Use the Studio to design and test
                    your own terms.
                </p>
                <p className="mt-3 text-[15px] leading-relaxed text-ink-2">
                    Meteora's Dynamic Bonding Curve (DBC) lets a token find its price on a configurable curve, then graduate into a DAMM v2 pool once the raise is
                    met. A DBC <em>config</em> fixes the whole launch, and Launchproof turns those configs into designed, tested, shareable products.
                </p>
            </Reveal>

            <Reveal delay={120} className="mt-8">
                <Card>
                    <Flow />
                </Card>
            </Reveal>

            <div className="mt-8 grid gap-4 md:grid-cols-2">
                <Step n={1} title="Design with shapes, not sqrt prices" delay={0}>
                    Pick a price path (linear, exponential, S-curve and more) and market caps. The compiler builds a DBC curve of up to 16 segments, so the pool
                    opens at the final price with no gap.
                </Step>
                <Step n={2} title="Simulate with official SDK quotes" delay={70}>
                    Quotes come from the official DBC SDK, which mirrors the program's fixed-point arithmetic. Seeded scenarios replay snipers, crowds, whales and
                    panics, so runs are reproducible.
                </Step>
                <Step n={3} title="Verified against the real program binary" delay={140}>
                    Tests run Meteora's real DBC and DAMM v2 binaries in LiteSVM, an in-process Solana VM. Covered trade scenarios compare simulator prices, reserves and fees against program execution.
                </Step>
                <Step n={4} title="Review before you publish" delay={210}>
                    Lint flags risky terms the chain accepts but traders pay for, such as sniper taxes, unlocked LP, thin pools and retained mint authority. The
                    0-100 design score is a heuristic, not a safety certification.
                </Step>
                <Step n={5} title="Publish: your preset becomes your launchpad" delay={280}>
                    Publishing makes your wallet the config's fee claimer (partner). Its configured share of DBC trading fees accrues when launched tokens trade. Earnings claims those DBC fees.
                </Step>
                <Step n={6} title="An on-chain registry with no indexer (CSR-1)" delay={350}>
                    A listing is a memo plus a 0-lamport transfer to a keyless registry address, <code className="font-mono text-[13px]">sha256("curvesmith:registry:v1")</code>.
                    Economics come from the real config, so only listings signed by its fee claimer count.
                    <code className="mt-2 block break-all font-mono text-[12px] text-muted">{REGISTRY_ADDRESS.toBase58()}</code>
                </Step>
                <Step n={7} title="Launch, trade, graduate, claim" delay={420} className="md:col-span-2">
                    Creators launch from any preset with a bundled first buy. Once the raise is met, anyone can graduate the token into DAMM v2, and authors and
                    creators can claim accrued DBC trading fees from Earnings. Migration fees, residual tokens and DAMM v2 fees require separate tools.
                </Step>
            </div>

            <Reveal className="mt-10">
                <Card>
                    <h2 className="text-[15px] font-semibold">For developers and agents</h2>
                    <p className="mt-1 text-[14px] leading-relaxed text-ink-2">
                        The engine is a TypeScript library, <code className="font-mono text-[13px]">@launchproof/core</code>, shared by this app, a CLI and an
                        MCP server for AI agents. The repository README covers the details.
                    </p>
                    <Link to="/studio" className="mt-3 inline-block text-[14px] font-semibold text-accent hover:underline">
                        Open the Studio
                    </Link>
                </Card>
            </Reveal>
        </div>
    )
}
