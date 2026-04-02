import { runAnalyticsIngestion } from "./stages/1-analytics.js"
import { runCompetitorResearch } from "./stages/2-competitor-research.js"
import { runVariantGeneration } from "./stages/3-variant-generation.js"
import { runDeployment } from "./stages/4-deployment.js"
import { runVerification } from "./stages/5-verification.js"
import { startRun, completeRun, failRun, updateRunThinking, setRunScreenshots } from "./run-store.js"
import { captureBeforeAfter, SCREENSHOTS_DIR } from "./utils/screenshot.js"
import type { AgentReport, Config } from "./types.js"

export async function runPipeline(config: Config, triggeredBy = "manual"): Promise<AgentReport> {
  const runRecord = startRun(triggeredBy)

  console.log("─────────────────────────────────────────────────")
  console.log(` Onboarding Optimizer Agent — ${runRecord.id}`)
  console.log("─────────────────────────────────────────────────")

  try {
    // Stage 1
    console.log("\n[Stage 1] Analytics ingestion")
    const { funnelData, problemSet } = await runAnalyticsIngestion(config)

    const worstStep = funnelData.steps.reduce(
      (max, s) => (s.drop_off_pct > max.drop_off_pct ? s : max),
      funnelData.steps[0]
    )
    updateRunThinking(runRecord, {
      stage1: {
        funnelSteps: funnelData.steps.map((s) => ({ name: s.name, users: s.users, dropOff: s.drop_off_pct })),
        worstStep: worstStep.name,
        dropOffPct: worstStep.drop_off_pct,
        problemTypes: problemSet.types,
        flaggedStep: problemSet.flagged_step,
        conversionRate: funnelData.conversion_rate,
        trialCancellationRate: funnelData.trial_cancellation_rate,
      },
    })

    console.log(`  Worst step: "${worstStep.name}" — ${Math.round(worstStep.drop_off_pct * 100)}% drop-off`)
    console.log(`  Problems: ${problemSet.types.join(", ") || "none"}`)
    console.log(`  Flagged: "${problemSet.flagged_step}" (index ${problemSet.flagged_step_index})`)

    if (problemSet.types.length === 0) {
      console.log("[Pipeline] No problems detected. Exiting.")
      const noOpReport = buildNoOpReport()
      completeRun(runRecord, noOpReport)
      return noOpReport
    }

    // Stage 2
    console.log("\n[Stage 2] Competitor research")
    const { patternLibrary, screenshotsAnalyzed } = await runCompetitorResearch(config, problemSet)

    updateRunThinking(runRecord, {
      stage2: {
        screenshotsAnalyzed,
        topTechniques: patternLibrary.top_techniques.slice(0, 5).map((t) => ({ name: t.technique, impact: t.conversion_impact })),
        dominantTone: patternLibrary.dominant_tone,
        frictionReducers: patternLibrary.friction_reducers.slice(0, 4),
        trustSignals: patternLibrary.trust_signals.slice(0, 4),
      },
    })

    console.log(`  Screenshots: ${screenshotsAnalyzed} | Tone: ${patternLibrary.dominant_tone}`)
    console.log(`  Techniques: ${patternLibrary.top_techniques.slice(0, 3).map((t) => t.technique).join(", ")}`)

    // Stage 3
    console.log("\n[Stage 3] Variant generation")
    const generatedFiles = await runVariantGeneration(config, funnelData, problemSet, patternLibrary)

    updateRunThinking(runRecord, {
      stage3: {
        selectedVariant: generatedFiles.selected.selected,
        reasoning: generatedFiles.selected.reasoning,
        codeVerified: true,
        failedVariants: [],
        lifetimeDealGenerated: !!generatedFiles.lifetimeDealCode,
      },
    })

    console.log(`  Selected: Variant ${generatedFiles.selected.selected} — ${generatedFiles.selected.reasoning}`)

    // Stage 4 — take "before" screenshot, deploy, take "after" screenshot
    console.log("\n[Stage 4] Deployment")

    let screenshotPair = { beforePath: null as string | null, afterPath: null as string | null }
    if (config.nutriBotUrl) {
      console.log(`  [Screenshot] Capturing before state: ${config.nutriBotUrl}`)
      const pair = await captureBeforeAfter(config.nutriBotUrl, runRecord.id)
      screenshotPair = pair
      setRunScreenshots(runRecord, pair)
    }

    const deployment = await runDeployment(config, generatedFiles, problemSet)

    updateRunThinking(runRecord, {
      stage4: {
        commitSha: deployment.commitSha,
        commitUrl: deployment.commitUrl,
        filesDeployed: deployment.filesDeployed,
      },
    })

    console.log(`  Commit: ${deployment.commitSha.slice(0, 8)} — ${deployment.commitUrl}`)
    if (screenshotPair.afterPath) {
      console.log(`  Screenshots saved: ${SCREENSHOTS_DIR}/${runRecord.id}/`)
    }

    // Stage 5
    console.log("\n[Stage 5] Verification")
    const report = await runVerification(
      config,
      funnelData,
      problemSet,
      generatedFiles,
      deployment,
      screenshotsAnalyzed
    )

    const rolledBack = report.changes.some((c) => c.includes("Rollback"))
    const improved = report.metrics.onboarding_completion.after > report.metrics.onboarding_completion.before

    updateRunThinking(runRecord, {
      stage5: { improved, rolledBack },
    })

    completeRun(runRecord, report)

    const { onboarding_completion, conversion_rate, revenue_per_day } = report.metrics
    console.log(`  Completion: ${pct(onboarding_completion.before)} → ${pct(onboarding_completion.after)}`)
    console.log(`  Conversion: ${pct(conversion_rate.before)} → ${pct(conversion_rate.after)}`)
    console.log(`  Revenue/day: $${revenue_per_day.before} → $${revenue_per_day.after}`)

    console.log("\n─────────────────────────────────────────────────")
    console.log(` Pipeline complete — ${runRecord.durationMs ?? 0}ms`)
    console.log("─────────────────────────────────────────────────\n")

    return report
  } catch (err) {
    failRun(runRecord, err)
    throw err
  }
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}

function buildNoOpReport(): AgentReport {
  return {
    problem_detected: "None — all metrics within acceptable thresholds",
    root_cause: "No action needed",
    screenshots_analyzed: 0,
    variant_deployed: "A",
    changes: [],
    metrics: {
      onboarding_completion: { before: 0, after: 0 },
      trial_cancellation: { before: 0, after: 0 },
      conversion_rate: { before: 0, after: 0 },
      revenue_per_day: { before: 0, after: 0 },
    },
  }
}
