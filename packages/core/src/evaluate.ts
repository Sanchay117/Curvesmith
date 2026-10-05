/**
 * The full evaluation pipeline used by the web app, CLI and MCP server alike:
 * analyze -> simulate scenarios -> lint (with simulation evidence).
 */
import { PoolConfig } from '@meteora-ag/dynamic-bonding-curve-sdk'
import { analyzeConfig, AnalyzedPreset, analyzePreset } from './analysis'
import { quoteDecimals } from './curve'
import { lintPreset, LintReport } from './lint'
import { PresetSpec } from './preset'
import { runScenario, ScenarioResult } from './sim/scenario'
import { SCENARIOS } from './sim/scenarios'

export interface Evaluation {
    analyzed: AnalyzedPreset
    runs: Record<string, ScenarioResult>
    lint: LintReport
}

export function simulate(analyzed: AnalyzedPreset, scenarioId: string): ScenarioResult {
    const scenario = SCENARIOS.find((s) => s.id === scenarioId)
    if (!scenario) throw new Error(`Unknown scenario ${scenarioId}`)
    return runScenario(analyzed.config, scenario, {
        totalSupply: analyzed.spec.token.supply,
        quoteDecimals: quoteDecimals(analyzed.spec),
    })
}

export function evaluateAnalyzed(analyzed: AnalyzedPreset, scenarioIds = ['organic', 'sniper-rush']): Evaluation {
    const runs: Record<string, ScenarioResult> = {}
    for (const id of scenarioIds) runs[id] = simulate(analyzed, id)
    const lint = lintPreset(analyzed, { sniperRun: runs['sniper-rush'], organicRun: runs['organic'] })
    return { analyzed, runs, lint }
}

export function evaluatePreset(spec: PresetSpec, scenarioIds?: string[]): Evaluation {
    return evaluateAnalyzed(analyzePreset(spec), scenarioIds)
}

export function evaluateConfig(spec: PresetSpec, config: PoolConfig, scenarioIds?: string[]): Evaluation {
    return evaluateAnalyzed(analyzeConfig(spec, config), scenarioIds)
}
