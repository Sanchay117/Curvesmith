/**
 * Launch linting: protocol errors the chain would reject, plus economic findings the chain
 * happily accepts but traders and creators pay for. Produces a 0-100 design heuristic.
 */
import { PublicKey } from '@solana/web3.js'
import { validateConfigParameters } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { AnalyzedPreset } from './analysis'
import { lpTotal, PresetSpec } from './preset'
import { ScenarioResult } from './sim/scenario'

export type Severity = 'critical' | 'warning' | 'info' | 'good'

export interface Finding {
    id: string
    severity: Severity
    title: string
    detail: string
}

export interface LintReport {
    findings: Finding[]
    score: number
    grade: 'A' | 'B' | 'C' | 'D' | 'F'
}

export interface LintContext {
    /** Optional simulation results; unlock findings about snipers and graduation speed. */
    sniperRun?: ScenarioResult
    organicRun?: ScenarioResult
}

const pct = (x: number, d = 1) => `${x.toFixed(d)}%`
const fmt = (x: number) =>
    x >= 1000 ? x.toLocaleString('en-US', { maximumFractionDigits: 0 }) : x.toLocaleString('en-US', { maximumFractionDigits: 2 })

/** Smallest graduated pool (in quote units) that still trades with reasonable depth. */
const THIN_POOL: Record<string, number> = { SOL: 25, USDC: 5_000 }

export function lintPreset(a: AnalyzedPreset, ctx: LintContext = {}): LintReport {
    const { spec, analysis: x } = a
    const out: Finding[] = []
    const add = (f: Finding) => out.push(f)

    // ---- protocol validity (what create_config would reject) ---------------------------
    if (lpTotal(spec) !== 100) {
        add({
            id: 'lp-sum',
            severity: 'critical',
            title: 'Graduated liquidity does not add up to 100%',
            detail: `Partner and creator LP shares sum to ${lpTotal(spec)}%. DBC requires exactly 100%.`,
        })
    }
    // a config already on chain passed the program's own validation; only check local designs
    if (a.params) {
        try {
            validateConfigParameters({ ...a.params, leftoverReceiver: new PublicKey('11111111111111111111111111111112') })
        } catch (e) {
            add({
                id: 'protocol',
                severity: 'critical',
                title: 'The DBC program would reject this config',
                detail: (e as Error).message,
            })
        }
    }

    // ---- token authority ---------------------------------------------------------------
    if (spec.token.authority.endsWith('mint')) {
        add({
            id: 'mint-authority',
            severity: 'warning',
            title: 'Mint authority survives the launch',
            detail: `With "${spec.token.authority}", more tokens can be minted after graduation. Only use this for assets with an off-chain backing that must track issuance (e.g. tokenized shares).`,
        })
    } else if (spec.token.authority === 'immutable') {
        add({ id: 'immutable', severity: 'good', title: 'Immutable token', detail: 'Metadata and supply are frozen at launch.' })
    }

    // ---- sniper economics ----------------------------------------------------------------
    const s = spec.fees.schedule
    const decays = s.startBps > s.endBps
    if (!decays) {
        add({
            id: 'no-time-decay',
            severity: 'info',
            title: 'No time-decaying base fee',
            detail: `The opening fee is ${pct(s.startBps / 100, 2)} without a time decay. This alone does not establish sniping risk or the absence of other protections.`,
        })
    }
    if (decays && s.duration > 3600 && s.startBps > 1000) {
        add({
            id: 'fee-decay-long',
            severity: 'warning',
            title: 'Sniper fee lingers for over an hour',
            detail: `The fee only reaches ${pct(s.endBps / 100, 2)} after ${fmt(s.duration / 60)} minutes, so real buyers in the first hour also pay the bot tax.`,
        })
    }
    if (ctx.sniperRun) {
        const sn = ctx.sniperRun.cohorts.find((c) => c.cohort === 'sniper')
        if (sn) {
            if (Math.abs(sn.roiPct) < 2) {
                add({
                    id: 'sniper-roi',
                    severity: 'good',
                    title: 'No sniper edge',
                    detail: `Bots that buy in the first 3 seconds end up ${pct(sn.roiPct, 1)}: there is no cheap bottom to farm.`,
                })
            } else if (sn.roiPct > 50) {
                add({
                    id: 'sniper-roi',
                    severity: 'warning',
                    title: `Snipers profit ${pct(sn.roiPct, 0)} in simulation`,
                    detail: `In the "Sniper rush" scenario, 15 bots that buy in the first 3 seconds and dump after 90s end up ${pct(sn.roiPct, 0)} up after paying ${fmt(sn.feesQuote)} ${spec.quote} in fees.`,
                })
            } else if (sn.roiPct < 0) {
                add({
                    id: 'sniper-roi',
                    severity: 'good',
                    title: `Snipers lose ${pct(-sn.roiPct, 0)} in simulation`,
                    detail: `The fee schedule converts sniping into ${fmt(sn.feesQuote)} ${spec.quote} of fees for the author and creator.`,
                })
            }
        }
    }
    if (spec.fees.firstSwapMinFee && s.startBps > s.endBps) {
        add({
            id: 'creator-first-buy',
            severity: 'good',
            title: 'Creator first buy skips the sniper tax',
            detail: 'A buy bundled with pool creation pays the minimum fee, so creators can seed their own launch.',
        })
    }

    // ---- liquidity safety ------------------------------------------------------------------
    const unlocked = spec.lp.partner.unlocked + spec.lp.creator.unlocked
    if (unlocked > 50) {
        add({
            id: 'unlocked-lp',
            severity: 'warning',
            title: `${unlocked}% of graduated liquidity is withdrawable on day one`,
            detail: 'Unlocked LP can be pulled right after graduation. Lock or vest most of it so holders can trust the pool.',
        })
    } else if (unlocked === 0) {
        add({
            id: 'locked-lp',
            severity: 'good',
            title: 'All graduated liquidity is locked or vesting',
            detail: 'Nobody can pull the DAMM v2 pool out from under holders right after graduation.',
        })
    }

    const thin = THIN_POOL[spec.quote] ?? 25
    if (x.graduationQuote < thin) {
        add({
            id: 'thin-pool',
            severity: 'warning',
            title: 'Thin graduated pool',
            detail: `Only ${fmt(x.graduationQuote)} ${spec.quote} seeds the DAMM v2 pool, so a ${fmt(x.refTrade)} ${spec.quote} buy moves the price ${pct(x.graduatedImpactPct)}.`,
        })
    }

    // ---- value extraction ------------------------------------------------------------------
    if (spec.migration.feePct > 10) {
        add({
            id: 'migration-fee',
            severity: 'warning',
            title: `${spec.migration.feePct}% of the raise is taken at graduation`,
            detail: 'That quote never reaches the pool, so the graduated pool is shallower and the fee is invisible to most buyers.',
        })
    }
    if (spec.fees.creatorSharePct === 0) {
        add({
            id: 'creator-share',
            severity: 'info',
            title: 'Creators earn no trading fees',
            detail: 'All curve fees go to the preset author. Creators may prefer presets that share fees.',
        })
    }
    if (spec.creatorAllocation && spec.creatorAllocation.pct > 10 && spec.creatorAllocation.cliffSeconds < 30 * 86_400) {
        add({
            id: 'creator-allocation',
            severity: 'warning',
            title: `${spec.creatorAllocation.pct}% creator allocation with a short cliff`,
            detail: 'Large insider allocations that unlock within a month are a common dump vector.',
        })
    }

    // ---- supply nobody bought or paired -----------------------------------------------------------
    if (x.leftoverPct > 5) {
        add({
            id: 'leftover-supply',
            severity: x.leftoverPct > 50 ? 'critical' : 'warning',
            title: `${pct(x.leftoverPct, 0)} of supply goes to the leftover receiver`,
            detail: `${fmt(x.leftover)} tokens are neither sold on the curve nor paired in the DAMM v2 pool. After graduation the config's leftover receiver can withdraw them, so holders of the curve float are diluted by that wallet.`,
        })
    }

    // ---- shape and distribution ---------------------------------------------------------------
    if (x.maxMultiple > 300) {
        add({
            id: 'price-range',
            severity: 'info',
            title: `First buyer can reach ${fmt(x.maxMultiple)}x by graduation`,
            detail: 'A very wide price range rewards the earliest wallets heavily. Fine for memes, unusual for RWAs.',
        })
    }
    if (x.soldPct < 15) {
        add({
            id: 'low-float',
            severity: 'info',
            title: `Only ${pct(x.soldPct)} of supply is sold on the curve`,
            detail: 'Most supply sits in liquidity or allocations; price discovery happens on a small float.',
        })
    }
    if (x.openingImpactPct > 100) {
        add({
            id: 'opening-impact',
            severity: 'warning',
            title: `Very thin opening liquidity`,
            detail: `Buying just 1% of the raise at launch moves the price ${pct(x.openingImpactPct, 0)}. Whoever buys first captures most of the early upside; make sure the fee schedule taxes that.`,
        })
    } else if (x.openingImpactPct > 8) {
        add({
            id: 'opening-impact',
            severity: 'info',
            title: `Thin opening liquidity`,
            detail: `Buying just 1% of the raise at launch moves the price ${pct(x.openingImpactPct)}.`,
        })
    }
    if (ctx.organicRun) {
        const r = ctx.organicRun
        if (!r.graduated) {
            const prog = r.timeline[r.timeline.length - 1]?.progress ?? 0
            add({
                id: 'no-graduation',
                severity: 'info',
                title: 'Does not graduate under organic demand',
                detail: `The "${r.scenario.name}" scenario reaches ${pct(prog * 100, 0)} of the raise in ${fmt(r.scenario.horizonSec / 3600)}h. Expect a long curve.`,
            })
        } else if (r.graduationSec !== null) {
            add({
                id: 'graduation-time',
                severity: 'good',
                title: `Graduates in ${fmt(r.graduationSec / 60)} minutes under organic demand`,
                detail: `${fmt(r.volumeQuote)} ${spec.quote} of volume; ${fmt(r.fees.partner)} ${spec.quote} to the author and ${fmt(r.fees.creator)} ${spec.quote} to the creator before graduation.`,
            })
        }
    }

    const weights: Record<Severity, number> = { critical: 40, warning: 12, info: 4, good: 0 }
    const raw = 100 - out.reduce((acc, f) => acc + weights[f.severity], 0)
    const score = Math.max(0, Math.min(100, Math.round(raw)))
    const hasCritical = out.some((f) => f.severity === 'critical')
    const grade: LintReport['grade'] = hasCritical
        ? 'F'
        : score >= 90
          ? 'A'
          : score >= 78
            ? 'B'
            : score >= 65
              ? 'C'
              : score >= 50
                ? 'D'
                : 'F'
    const order: Record<Severity, number> = { critical: 0, warning: 1, info: 2, good: 3 }
    out.sort((p, q) => order[p.severity] - order[q.severity])
    return { findings: out, score: hasCritical ? Math.min(score, 30) : score, grade }
}
