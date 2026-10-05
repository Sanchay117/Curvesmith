import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import BN from 'bn.js'
import {
    clonePreset,
    defaultPreset,
    Evaluation,
    evaluatePreset,
    LIBRARY,
    LIBRARY_IDS,
    PRESET_SCHEMA,
    PresetSpec,
    resolveEndMcap,
} from '@curvesmith/core'
import { Controls } from '../components/studio/Controls'
import { PublishPanel } from '../components/studio/PublishPanel'
import { CurveChart, EconomicsGrid, FeeChart, LintPanel, LiquidityBar, Panel, SimulationPanel, SupplyBar } from '../components/PresetViews'
import { Button, Card, cx, GradeBadge, Segmented, Select } from '../components/ui'
import { templateEvaluation } from '../lib/evaluations'
import { useListings } from '../lib/queries'
import { useNetwork } from '../lib/network'
import { listingSpec } from '../lib/evaluations'
import { useToast } from '../lib/toast'

const DRAFT_KEY = 'cs.studio.draft'

function encodeSpec(spec: PresetSpec): string {
    const json = JSON.stringify(spec)
    return btoa(String.fromCharCode(...new TextEncoder().encode(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function decodeSpec(s: string): PresetSpec | null {
    try {
        const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))
        const spec = JSON.parse(new TextDecoder().decode(bytes))
        return spec?.schema === PRESET_SCHEMA ? spec : null
    } catch {
        return null
    }
}

function loadDraft(): PresetSpec | null {
    try {
        const raw = localStorage.getItem(DRAFT_KEY)
        const spec = raw ? JSON.parse(raw) : null
        return spec?.schema === PRESET_SCHEMA ? spec : null
    } catch {
        return null
    }
}

/** BN-aware JSON for the "on-chain config" view. */
function toJson(x: unknown): string {
    return JSON.stringify(
        x,
        (_, v) => (BN.isBN(v) ? v.toString() : v && typeof v === 'object' && 'toBase58' in v ? (v as { toBase58(): string }).toBase58() : v),
        2
    )
}

export function Studio() {
    const [params, setParams] = useSearchParams()
    const { network } = useNetwork()
    const listings = useListings()
    const toast = useToast()

    const [spec, setSpec] = useState<PresetSpec>(() => {
        const s = params.get('s')
        const t = params.get('template')
        if (s) return decodeSpec(s) ?? defaultPreset()
        if (t && LIBRARY[t]) return clonePreset(LIBRARY[t])
        return loadDraft() ?? clonePreset(LIBRARY['fair-meme'])
    })

    // Links like /studio?template=x must work while the Studio is already open (React Router
    // keeps the component mounted across search-param changes, so the initializer won't rerun).
    const templateParam = params.get('template')
    const shareParam = params.get('s')
    const lastParams = useRef(`${templateParam}|${shareParam}`)
    useEffect(() => {
        const key = `${templateParam}|${shareParam}`
        if (key === lastParams.current) return
        lastParams.current = key
        if (shareParam) {
            const decoded = decodeSpec(shareParam)
            if (decoded) setSpec(decoded)
        } else if (templateParam && LIBRARY[templateParam]) {
            setSpec(clonePreset(LIBRARY[templateParam]))
        }
    }, [templateParam, shareParam])

    // fork from an on-chain preset once listings arrive
    const forkedFrom = params.get('fork')
    const forked = useRef(false)
    useEffect(() => {
        if (!forkedFrom || forked.current || !listings.data) return
        const l = listings.data.find((x) => x.config.toBase58() === forkedFrom)
        if (l) {
            forked.current = true
            setSpec({ ...listingSpec(l, network), name: `${l.meta.n} (fork)` })
        }
    }, [forkedFrom, listings.data, network])

    useEffect(() => {
        const id = setTimeout(() => {
            try {
                localStorage.setItem(DRAFT_KEY, JSON.stringify(spec))
            } catch {
                /* ignore */
            }
        }, 400)
        return () => clearTimeout(id)
    }, [spec])

    const set = useCallback((fn: (s: PresetSpec) => void) => {
        setSpec((prev) => {
            const next = clonePreset(prev)
            fn(next)
            return next
        })
    }, [])

    // evaluation lags input slightly so dragging sliders stays smooth
    const deferred = useDeferredValue(spec)
    const lastGood = useRef<Evaluation | null>(null)
    const { evaluation, error } = useMemo(() => {
        try {
            const e = evaluatePreset(deferred)
            lastGood.current = e
            return { evaluation: e, error: null as string | null }
        } catch (e) {
            return { evaluation: lastGood.current, error: (e as Error).message }
        }
    }, [deferred])
    const stale = deferred !== spec || !!error

    const [compareId, setCompareId] = useState<string>('none')
    const compare = useMemo(() => {
        if (compareId === 'none') return undefined
        const ev = templateEvaluation(compareId)
        return ev instanceof Error ? undefined : { a: ev.analyzed, label: LIBRARY[compareId].name }
    }, [compareId])

    const [tab, setTab] = useState<'overview' | 'simulate' | 'lint' | 'config'>('overview')

    const onTargetRaise = (target: number) => {
        if (!evaluation) return
        const k = target / evaluation.analyzed.analysis.raise
        set((s) => {
            s.pricing.startMcap *= k
            s.pricing.endMcap = Math.max(s.pricing.endMcap * k, s.pricing.startMcap * 1.01)
        })
    }

    const share = () => {
        const url = `${window.location.origin}${window.location.pathname}#/studio?s=${encodeSpec(spec)}`
        navigator.clipboard?.writeText(url)
        setParams({ s: encodeSpec(spec) }, { replace: true })
        toast({ kind: 'info', title: 'Share link copied', body: 'Anyone with the link opens this exact design.' })
    }

    const download = () => {
        const blob = new Blob([JSON.stringify(spec, null, 2)], { type: 'application/json' })
        const a = document.createElement('a')
        a.href = URL.createObjectURL(blob)
        a.download = `${spec.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'preset'}.curvesmith.json`
        a.click()
        URL.revokeObjectURL(a.href)
    }

    const importFile = (file: File) => {
        file.text().then((t) => {
            try {
                const s = JSON.parse(t)
                if (s?.schema !== PRESET_SCHEMA) throw new Error('not a Curvesmith preset')
                setSpec(s)
            } catch (e) {
                toast({ kind: 'error', title: 'Import failed', body: (e as Error).message })
            }
        })
    }

    const a = evaluation?.analyzed

    return (
        <div>
            <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
                <div>
                    <h1 className="text-3xl font-semibold tracking-tight">Studio</h1>
                    <p className="mt-1 text-[14px] text-ink-2">
                        Design a launch, watch it trade against bots and crowds, then publish it as a real DBC config.
                    </p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                    <div className="w-48">
                        <Select
                            value=""
                            onChange={(id) => id && setSpec(clonePreset(LIBRARY[id]))}
                            options={[{ value: '', label: 'Start from template...' }, ...LIBRARY_IDS.map((id) => ({ value: id, label: LIBRARY[id].name }))]}
                        />
                    </div>
                    <Button size="md" onClick={share}>
                        Share link
                    </Button>
                    <Button size="md" onClick={download}>
                        Export
                    </Button>
                    <label className="inline-flex h-9 cursor-pointer items-center rounded-[10px] border border-line-strong bg-surface-2 px-3.5 text-sm font-semibold hover:bg-surface-3">
                        Import
                        <input type="file" accept="application/json" className="hidden" onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
                    </label>
                </div>
            </div>

            <div className="grid grid-cols-1 gap-6 lg:grid-cols-[380px_minmax(0,1fr)]">
                <aside className="rounded-2xl border border-line bg-surface px-4 lg:sticky lg:top-24 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto">
                    <Controls spec={spec} set={set} onTargetRaise={onTargetRaise} raise={a?.analysis.raise ?? null} />
                </aside>

                <div className="min-w-0 space-y-5">
                    {error && (
                        <div className="rounded-xl border border-critical/40 bg-surface px-4 py-3 text-[13px]">
                            <span className="font-semibold">This design does not compile:</span> <span className="text-ink-2">{error}</span>
                            <div className="mt-1 text-xs text-muted">Showing the last valid version below.</div>
                        </div>
                    )}

                    <Card className={cx('transition-opacity', stale && 'opacity-70')}>
                        <div className="flex flex-wrap items-center justify-between gap-4">
                            <div className="min-w-0">
                                <div className="truncate text-xl font-semibold">{spec.name || 'Untitled'}</div>
                                <div className="truncate text-[13px] text-ink-2">{spec.tagline}</div>
                            </div>
                            {evaluation && <GradeBadge grade={evaluation.lint.grade} score={evaluation.lint.score} size="lg" />}
                        </div>
                        {a && (
                            <div className="mt-5">
                                <EconomicsGrid a={a} />
                            </div>
                        )}
                    </Card>

                    <div className="flex flex-wrap items-center justify-between gap-3">
                        <Segmented
                            value={tab}
                            onChange={setTab}
                            options={[
                                { value: 'overview', label: 'Curve & supply' },
                                { value: 'simulate', label: 'Simulate' },
                                { value: 'lint', label: `Review${evaluation ? ` (${evaluation.lint.findings.filter((f) => f.severity !== 'good').length})` : ''}` },
                                { value: 'config', label: 'On-chain config' },
                            ]}
                        />
                        {tab === 'overview' && (
                            <div className="flex items-center gap-2 text-xs text-muted">
                                Compare with
                                <div className="w-44">
                                    <Select
                                        value={compareId}
                                        onChange={setCompareId}
                                        options={[{ value: 'none', label: 'nothing' }, ...LIBRARY_IDS.map((id) => ({ value: id, label: LIBRARY[id].name }))]}
                                    />
                                </div>
                            </div>
                        )}
                    </div>

                    {a && evaluation && (
                        <div className={cx('space-y-5 transition-opacity', stale && 'opacity-70')}>
                            {tab === 'overview' && (
                                <>
                                    <Panel title="Price path" hint={`${a.analysis.segments}-segment DBC curve compiled from the ${spec.pricing.shape.kind.replace('-', ' ')} shape; graduation at ${Math.round(resolveEndMcap(spec)).toLocaleString()} ${spec.quote} market cap.`}>
                                        <CurveChart a={a} compare={compare} />
                                    </Panel>
                                    <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                                        <Panel title="Where the supply goes">
                                            <SupplyBar a={a} />
                                        </Panel>
                                        <Panel title="Who owns graduated liquidity">
                                            <LiquidityBar spec={spec} />
                                        </Panel>
                                    </div>
                                    <Panel title="Fee schedule" hint="Base fee by time since launch. The dynamic fee, if on, adds a volatility surcharge.">
                                        <FeeChart a={a} />
                                    </Panel>
                                </>
                            )}
                            {tab === 'simulate' && (
                                <Panel title="Simulation" hint="Agent-based market replay on the exact pool math">
                                    <SimulationPanel a={a} runs={evaluation.runs} />
                                </Panel>
                            )}
                            {tab === 'lint' && (
                                <Panel title="Launch review" hint="Protocol checks plus economic findings backed by simulation">
                                    <LintPanel report={evaluation.lint} />
                                </Panel>
                            )}
                            {tab === 'config' && (
                                <Panel title="What goes on chain" hint="The exact create_config parameters (Q64.64 sqrt prices, u128 liquidities, fee numerators)">
                                    <pre className="max-h-[560px] overflow-auto rounded-xl bg-surface-2 p-4 font-mono text-xs leading-relaxed text-ink-2">
                                        {toJson(a.params)}
                                    </pre>
                                </Panel>
                            )}
                        </div>
                    )}

                    <PublishPanel spec={spec} lint={error ? null : (evaluation?.lint ?? null)} />
                </div>
            </div>
        </div>
    )
}
