import { ReactNode, useState } from 'react'
import { lpTotal, PresetCategory, PresetSpec, resolveEndMcap, TokenAuthority } from '@launchproof/core'
import { cx, Field, InfoTip, NumberInput, Segmented, Select, Slider, TextArea, TextInput, Toggle } from '../ui'
import { defaultShape, FreehandEditor, ShapePicker, TrancheEditor } from './ShapeEditors'
import { CATEGORY_LABEL } from '../PresetCard'
import { num } from '../../lib/format'

type Set = (fn: (s: PresetSpec) => void) => void

function Section({ title, hint, children, defaultOpen = true }: { title: string; hint?: string; children: ReactNode; defaultOpen?: boolean }) {
    const [open, setOpen] = useState(defaultOpen)
    return (
        <section className="border-b border-line last:border-0">
            <button type="button" onClick={() => setOpen((o) => !o)} className="flex w-full items-center justify-between py-4 text-left">
                <div>
                    <div className="text-[14px] font-semibold">{title}</div>
                    {hint && <div className="text-xs text-muted">{hint}</div>}
                </div>
                <svg width="14" height="14" viewBox="0 0 14 14" className={cx('text-muted transition-transform', open && 'rotate-180')} aria-hidden>
                    <path d="M3 5l4 4 4-4" stroke="currentColor" strokeWidth="1.6" fill="none" strokeLinecap="round" />
                </svg>
            </button>
            {open && <div className="space-y-4 pb-5">{children}</div>}
        </section>
    )
}

const DAY = 86_400

export function Controls({ spec, set, onTargetRaise, raise }: { spec: PresetSpec; set: Set; onTargetRaise: (raise: number) => void; raise: number | null }) {
    const shape = spec.pricing.shape
    const q = spec.quote
    const ownEnd = shape.kind === 'flat' || shape.kind === 'tranches' || shape.kind === 'custom'
    const [target, setTarget] = useState<number | null>(null)
    const lp = lpTotal(spec)
    const fixedPool = spec.migration.pool.kind === 'fixed'

    return (
        <div>
            <Section title="Curve" hint="How price moves as the sale fills">
                <ShapePicker
                    value={shape.kind}
                    onChange={(k) =>
                        set((s) => {
                            s.pricing.shape = defaultShape(k)
                        })
                    }
                />
                {shape.kind === 'power' && (
                    <Field label="Exponent" hint="< 1 front-loads growth, > 1 back-loads it">
                        <Slider value={shape.exponent} min={0.2} max={4} step={0.05} onChange={(v) => set((s) => void ((s.pricing.shape as typeof shape).exponent = v))} format={(v) => v.toFixed(2)} />
                    </Field>
                )}
                {shape.kind === 'sigmoid' && (
                    <>
                        <Field label="Steepness">
                            <Slider value={shape.steepness} min={2} max={20} step={0.5} onChange={(v) => set((s) => void ((s.pricing.shape as typeof shape).steepness = v))} />
                        </Field>
                        <Field label="Midpoint" hint="where the fast repricing happens">
                            <Slider value={shape.midpoint} min={0.1} max={0.9} step={0.05} onChange={(v) => set((s) => void ((s.pricing.shape as typeof shape).midpoint = v))} format={(v) => `${Math.round(v * 100)}%`} />
                        </Field>
                    </>
                )}
                {shape.kind === 'flat' && (
                    <Field label="Price band" hint="how far price may drift during the sale">
                        <Slider value={shape.bandBps} min={10} max={500} step={5} onChange={(v) => set((s) => void ((s.pricing.shape as typeof shape).bandBps = v))} format={(v) => `${(v / 100).toFixed(2)}%`} />
                    </Field>
                )}
                {shape.kind === 'tranches' && (
                    <TrancheEditor shape={shape} onChange={(t) => set((s) => void (s.pricing.shape = t))} />
                )}
                {shape.kind === 'custom' && <FreehandEditor points={shape.points} onChange={(p) => set((s) => void (s.pricing.shape = { kind: 'custom', points: p }))} />}
            </Section>

            <Section title="Pricing" hint="Market caps are fully diluted, in the quote asset">
                <div className="grid grid-cols-2 gap-3">
                    <Field label="Quote asset">
                        <Segmented
                            value={q}
                            onChange={(v) => set((s) => void (s.quote = v))}
                            options={[
                                { value: 'SOL', label: 'SOL' },
                                { value: 'USDC', label: 'USDC' },
                            ]}
                        />
                    </Field>
                    <Field label="Total supply">
                        <NumberInput value={spec.token.supply} min={1000} onChange={(v) => set((s) => void (s.token.supply = Math.max(1000, Math.round(v))))} />
                    </Field>
                    <Field label="Start market cap">
                        <NumberInput value={spec.pricing.startMcap} suffix={q} onChange={(v) => set((s) => void (s.pricing.startMcap = Math.max(1e-6, v)))} />
                    </Field>
                    <Field label={ownEnd ? 'Graduation mcap (from shape)' : 'Graduation market cap'}>
                        {ownEnd ? (
                            <div className="tnum flex h-9 items-center rounded-[10px] border border-line px-3 text-sm text-muted">{num(resolveEndMcap(spec))}</div>
                        ) : (
                            <NumberInput value={spec.pricing.endMcap} suffix={q} onChange={(v) => set((s) => void (s.pricing.endMcap = Math.max(s.pricing.startMcap * 1.01, v)))} />
                        )}
                    </Field>
                </div>
                <div className="rounded-xl bg-surface-2 p-3">
                    <div className="mb-2 flex items-center gap-1.5 text-[13px] font-medium">
                        Solve for a raise
                        <InfoTip>
                            For a fixed curve shape, the raise scales exactly with market cap and does not depend on supply. Enter the quote you want the
                            curve to collect and both market caps are rescaled to hit it.
                        </InfoTip>
                    </div>
                    <div className="flex gap-2">
                        <NumberInput className="flex-1" value={target ?? Math.round((raise ?? 0) * 100) / 100} suffix={q} onChange={setTarget} />
                        <button
                            type="button"
                            disabled={!target || !raise}
                            onClick={() => target && onTargetRaise(target)}
                            className="h-9 rounded-[10px] bg-accent px-3 text-[13px] font-semibold text-accent-ink disabled:opacity-40"
                        >
                            Apply
                        </button>
                    </div>
                </div>
            </Section>

            <Section title="Trading fees" hint="Charged on every curve trade; 20% goes to the protocol">
                <div className="grid grid-cols-2 gap-3">
                    <Field label="Opening fee">
                        <NumberInput value={spec.fees.schedule.startBps / 100} suffix="%" step={0.25} onChange={(v) => set((s) => void (s.fees.schedule.startBps = Math.round(Math.min(99, Math.max(0.25, v)) * 100)))} />
                    </Field>
                    <Field label="Settled fee">
                        <NumberInput value={spec.fees.schedule.endBps / 100} suffix="%" step={0.05} onChange={(v) => set((s) => void (s.fees.schedule.endBps = Math.round(Math.min(s.fees.schedule.startBps / 100, Math.max(0.25, v)) * 100)))} />
                    </Field>
                    <Field label="Decay time">
                        <NumberInput value={spec.fees.schedule.duration} suffix={spec.activation === 'slot' ? 'slots' : 'sec'} onChange={(v) => set((s) => void (s.fees.schedule.duration = Math.max(0, Math.round(v))))} />
                    </Field>
                    <Field label="Decay steps">
                        <NumberInput value={spec.fees.schedule.periods} onChange={(v) => set((s) => void (s.fees.schedule.periods = Math.max(0, Math.round(v))))} />
                    </Field>
                </div>
                <Field label="Decay shape">
                    <Segmented
                        value={spec.fees.schedule.mode}
                        onChange={(v) => set((s) => void (s.fees.schedule.mode = v))}
                        options={[
                            { value: 'exponential', label: 'Exponential' },
                            { value: 'linear', label: 'Linear' },
                        ]}
                    />
                </Field>
                <Field label="Creator's share of trading fees" hint="the rest goes to you, the preset author">
                    <Slider value={spec.fees.creatorSharePct} min={0} max={100} onChange={(v) => set((s) => void (s.fees.creatorSharePct = v))} format={(v) => `${v}%`} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                    <Field label="Fees collected in">
                        <Segmented
                            value={spec.fees.collect}
                            onChange={(v) => set((s) => void (s.fees.collect = v))}
                            options={[
                                { value: 'quote', label: q },
                                { value: 'output', label: 'Output token' },
                            ]}
                        />
                    </Field>
                    <Field label="Launch fee" hint="paid by creators">
                        <NumberInput value={spec.fees.poolCreationFeeSol} suffix="SOL" step={0.01} onChange={(v) => set((s) => void (s.fees.poolCreationFeeSol = v <= 0 ? 0 : Math.min(100, Math.max(0.001, v))))} />
                    </Field>
                </div>
                <Toggle checked={spec.fees.dynamic} onChange={(v) => set((s) => void (s.fees.dynamic = v))} label="Dynamic fee" hint="Volatility surcharge on top of the base fee, like DLMM" />
                <Toggle
                    checked={spec.fees.firstSwapMinFee}
                    onChange={(v) => set((s) => void (s.fees.firstSwapMinFee = v))}
                    label="Creator first buy at minimum fee"
                    hint="A buy bundled with pool creation skips the sniper tax"
                />
            </Section>

            <Section title="Graduation" hint="What the token becomes when the raise completes">
                <Field label="DAMM v2 pool fee">
                    <Segmented
                        value={fixedPool ? 'fixed' : 'custom'}
                        onChange={(v) =>
                            set((s) => {
                                s.migration.pool = v === 'fixed' ? { kind: 'fixed', bps: 100 } : { kind: 'custom', bps: 100, dynamic: true, collect: 'quote' }
                            })
                        }
                        options={[
                            { value: 'fixed', label: 'Standard tier' },
                            { value: 'custom', label: 'Custom' },
                        ]}
                    />
                </Field>
                {spec.migration.pool.kind === 'fixed' ? (
                    <Select
                        value={String(spec.migration.pool.bps)}
                        onChange={(v) => set((s) => void (s.migration.pool = { kind: 'fixed', bps: Number(v) as 25 }))}
                        options={[25, 30, 100, 200, 400, 600].map((b) => ({ value: String(b), label: `${(b / 100).toFixed(2)}%` }))}
                    />
                ) : (
                    <CustomPool spec={spec} set={set} />
                )}
                <div className="grid grid-cols-2 gap-3">
                    <Field label="Graduation fee" hint="% of the raise">
                        <NumberInput value={spec.migration.feePct} suffix="%" onChange={(v) => set((s) => void (s.migration.feePct = Math.min(99, Math.max(0, Math.round(v)))))} />
                    </Field>
                    <Field label="Creator's share of it">
                        <NumberInput value={spec.migration.creatorFeeSharePct} suffix="%" onChange={(v) => set((s) => void (s.migration.creatorFeeSharePct = Math.min(100, Math.max(0, Math.round(v)))))} />
                    </Field>
                </div>
            </Section>

            <Section title="Graduated liquidity" hint="Who owns the DAMM v2 LP, and what is locked">
                <div className={cx('rounded-lg px-3 py-2 text-xs', lp === 100 ? 'bg-surface-2 text-ink-2' : 'bg-accent-wash text-ink')}>
                    Shares add up to <span className="tnum font-semibold">{lp}%</span> {lp !== 100 && '(must be exactly 100%)'}. At least 10% must stay locked one day after graduation.
                </div>
                {(['partner', 'creator'] as const).map((who) => (
                    <div key={who}>
                        <div className="mb-2 text-[13px] font-semibold">{who === 'partner' ? 'You (preset author)' : 'Token creator'}</div>
                        <div className="grid grid-cols-3 gap-2">
                            <Field label="Locked">
                                <NumberInput value={spec.lp[who].locked} suffix="%" onChange={(v) => set((s) => void (s.lp[who].locked = Math.max(0, Math.round(v))))} />
                            </Field>
                            <Field label="Vesting">
                                <NumberInput
                                    value={spec.lp[who].vesting?.pct ?? 0}
                                    suffix="%"
                                    onChange={(v) =>
                                        set((s) => {
                                            const pct = Math.max(0, Math.round(v))
                                            s.lp[who].vesting = pct === 0 ? undefined : { ...(s.lp[who].vesting ?? { cliffSeconds: 7 * DAY, periods: 12, durationSeconds: 180 * DAY }), pct }
                                        })
                                    }
                                />
                            </Field>
                            <Field label="Unlocked">
                                <NumberInput value={spec.lp[who].unlocked} suffix="%" onChange={(v) => set((s) => void (s.lp[who].unlocked = Math.max(0, Math.round(v))))} />
                            </Field>
                        </div>
                        {spec.lp[who].vesting && (
                            <div className="mt-2 grid grid-cols-3 gap-2">
                                <Field label="Cliff">
                                    <NumberInput value={Math.round(spec.lp[who].vesting!.cliffSeconds / DAY)} suffix="days" onChange={(v) => set((s) => void (s.lp[who].vesting!.cliffSeconds = Math.max(0, Math.round(v)) * DAY))} />
                                </Field>
                                <Field label="Unlocks">
                                    <NumberInput value={spec.lp[who].vesting!.periods} onChange={(v) => set((s) => void (s.lp[who].vesting!.periods = Math.max(1, Math.round(v))))} />
                                </Field>
                                <Field label="Over">
                                    <NumberInput value={Math.round(spec.lp[who].vesting!.durationSeconds / DAY)} suffix="days" onChange={(v) => set((s) => void (s.lp[who].vesting!.durationSeconds = Math.max(1, Math.round(v)) * DAY))} />
                                </Field>
                            </div>
                        )}
                    </div>
                ))}
            </Section>

            <Section title="Creator allocation" hint="Optional tokens locked for the creator, vesting after graduation" defaultOpen={!!spec.creatorAllocation}>
                <Toggle
                    checked={!!spec.creatorAllocation}
                    onChange={(v) =>
                        set((s) => {
                            s.creatorAllocation = v ? { pct: 5, cliffSeconds: 90 * DAY, cliffUnlockPct: 20, periods: 9, durationSeconds: 270 * DAY } : undefined
                        })
                    }
                    label="Reserve a creator allocation"
                />
                {spec.creatorAllocation && (
                    <div className="grid grid-cols-2 gap-3">
                        <Field label="Size" hint="% of supply">
                            <NumberInput value={spec.creatorAllocation.pct} suffix="%" onChange={(v) => set((s) => void (s.creatorAllocation!.pct = Math.min(50, Math.max(0.1, v))))} />
                        </Field>
                        <Field label="Cliff">
                            <NumberInput value={Math.round(spec.creatorAllocation.cliffSeconds / DAY)} suffix="days" onChange={(v) => set((s) => void (s.creatorAllocation!.cliffSeconds = Math.max(0, Math.round(v)) * DAY))} />
                        </Field>
                        <Field label="Unlocked at cliff">
                            <NumberInput value={spec.creatorAllocation.cliffUnlockPct} suffix="%" onChange={(v) => set((s) => void (s.creatorAllocation!.cliffUnlockPct = Math.min(100, Math.max(0, Math.round(v)))))} />
                        </Field>
                        <Field label="Then vests over">
                            <NumberInput value={Math.round(spec.creatorAllocation.durationSeconds / DAY)} suffix="days" onChange={(v) => set((s) => void (s.creatorAllocation!.durationSeconds = Math.max(1, Math.round(v)) * DAY))} />
                        </Field>
                    </div>
                )}
            </Section>

            <Section title="Token" hint="Standard, authority and activation" defaultOpen={false}>
                <div className="grid grid-cols-2 gap-3">
                    <Field label="Standard">
                        <Segmented
                            value={spec.token.standard}
                            onChange={(v) => set((s) => void (s.token.standard = v))}
                            options={[
                                { value: 'spl', label: 'SPL' },
                                { value: 'token2022', label: 'Token-2022' },
                            ]}
                        />
                    </Field>
                    <Field label="Decimals">
                        <Segmented
                            value={String(spec.token.decimals) as '6' | '9'}
                            onChange={(v) => set((s) => void (s.token.decimals = Number(v) as 6 | 9))}
                            options={[
                                { value: '6', label: '6' },
                                { value: '9', label: '9' },
                            ]}
                        />
                    </Field>
                </div>
                <Field label="Authority after launch">
                    <Select
                        value={spec.token.authority}
                        onChange={(v) => set((s) => void (s.token.authority = v as TokenAuthority))}
                        options={[
                            { value: 'immutable', label: 'Immutable (recommended)' },
                            { value: 'creator-update', label: 'Creator can update metadata' },
                            { value: 'partner-update', label: 'Author can update metadata' },
                            { value: 'creator-update-and-mint', label: 'Creator keeps mint authority' },
                            { value: 'partner-update-and-mint', label: 'Author keeps mint authority' },
                        ]}
                    />
                </Field>
                <Field label="Fee clock">
                    <Segmented
                        value={spec.activation}
                        onChange={(v) => set((s) => void (s.activation = v))}
                        options={[
                            { value: 'timestamp', label: 'Seconds' },
                            { value: 'slot', label: 'Slots (~400ms)' },
                        ]}
                    />
                </Field>
            </Section>

            <Section title="Listing" hint="How the preset appears in the marketplace">
                <Field label="Name">
                    <TextInput value={spec.name} maxLength={48} onChange={(e) => set((s) => void (s.name = e.target.value))} />
                </Field>
                <Field label="Tagline">
                    <TextInput value={spec.tagline} maxLength={96} onChange={(e) => set((s) => void (s.tagline = e.target.value))} />
                </Field>
                <Field label="Description" hint={`${spec.description.length}/420`}>
                    <TextArea value={spec.description} maxLength={420} rows={4} onChange={(e) => set((s) => void (s.description = e.target.value))} />
                </Field>
                <div className="grid grid-cols-2 gap-3">
                    <Field label="Category">
                        <Select
                            value={spec.category}
                            onChange={(v) => set((s) => void (s.category = v as PresetCategory))}
                            options={(Object.keys(CATEGORY_LABEL) as PresetCategory[]).map((c) => ({ value: c, label: CATEGORY_LABEL[c] }))}
                        />
                    </Field>
                    <Field label="Tags" hint="comma separated">
                        <TextInput
                            value={spec.tags.join(', ')}
                            onChange={(e) =>
                                set((s) => {
                                    s.tags = e.target.value.split(',').map((t) => t.trim()).filter(Boolean).slice(0, 6)
                                })
                            }
                        />
                    </Field>
                </div>
            </Section>
        </div>
    )
}

function CustomPool({ spec, set }: { spec: PresetSpec; set: Set }) {
    const pool = spec.migration.pool as Extract<PresetSpec['migration']['pool'], { kind: 'custom' }>
    const sched = pool.marketCapSchedule
    return (
        <div className="space-y-3 rounded-xl bg-surface-2 p-3">
            <div className="grid grid-cols-2 gap-3">
                <Field label="Pool fee">
                    <NumberInput value={pool.bps / 100} suffix="%" step={0.05} onChange={(v) => set((s) => void ((s.migration.pool as typeof pool).bps = Math.round(Math.min(10, Math.max(0.1, v)) * 100)))} />
                </Field>
                <Field label="LP fees paid in">
                    <Select
                        value={pool.collect}
                        onChange={(v) => set((s) => void ((s.migration.pool as typeof pool).collect = v))}
                        options={[
                            { value: 'quote', label: spec.quote },
                            { value: 'output', label: 'Output token' },
                            { value: 'compounding', label: 'Compounding' },
                        ]}
                    />
                </Field>
            </div>
            <Toggle checked={pool.dynamic} onChange={(v) => set((s) => void ((s.migration.pool as typeof pool).dynamic = v))} label="Dynamic fee on the DAMM v2 pool" />
            <Toggle
                checked={!!sched}
                onChange={(v) =>
                    set((s) => {
                        const p = s.migration.pool as typeof pool
                        p.marketCapSchedule = v ? { mode: 'exponential', endBps: Math.max(10, Math.min(25, Math.round(s.fees.schedule.endBps / 2))), periods: 50, priceMultiple: 10, expirySeconds: 30 * DAY } : undefined
                    })
                }
                label="Market-cap fee scheduler"
                hint="Pool fee decays as the token's price grows after graduation"
            />
            {sched && (
                <div className="grid grid-cols-3 gap-2">
                    <Field label="Ends at">
                        <NumberInput value={sched.endBps / 100} suffix="%" step={0.05} onChange={(v) => set((s) => void ((s.migration.pool as typeof pool).marketCapSchedule!.endBps = Math.round(Math.max(0.1, v) * 100)))} />
                    </Field>
                    <Field label="By price">
                        <NumberInput value={sched.priceMultiple} suffix="x" onChange={(v) => set((s) => void ((s.migration.pool as typeof pool).marketCapSchedule!.priceMultiple = Math.max(1.1, v)))} />
                    </Field>
                    <Field label="Steps">
                        <NumberInput value={sched.periods} onChange={(v) => set((s) => void ((s.migration.pool as typeof pool).marketCapSchedule!.periods = Math.max(1, Math.round(v))))} />
                    </Field>
                </div>
            )}
        </div>
    )
}
