import type { Config, FunnelData, FunnelStep, ProblemSet, ProblemType } from "../types.js"
import { withRetry } from "../utils/retry.js"

const DROP_OFF_FRICTION_THRESHOLD = 0.4
const TRIAL_CANCEL_THRESHOLD = 0.5
const CONVERSION_LOW_THRESHOLD = 0.15
const HIGH_INTENT_SESSION_THRESHOLD = 180 // 3 minutes

// NutriBot onboarding funnel — matches posthog.tsx event names exactly
const NUTRIBOT_FUNNEL_STEPS = [
  { id: "clicked_get_started",       name: "clicked_get_started",       order: 0 },
  { id: "viewed_goal_selection",      name: "viewed_goal_selection",      order: 1 },
  { id: "viewed_body_stats",          name: "viewed_body_stats",          order: 2 },
  { id: "viewed_activity_level",      name: "viewed_activity_level",      order: 3 },
  { id: "viewed_diet_preferences",    name: "viewed_diet_preferences",    order: 4 },
  { id: "viewed_your_plan",           name: "viewed_your_plan",           order: 5 },
  { id: "viewed_paywall",             name: "viewed_paywall",             order: 6 },
  { id: "completed_onboarding",       name: "completed_onboarding",       order: 7 },
]

type PostHogFunnelResult = {
  result: Array<{
    name: string
    count: number
    order: number
  }>
}

export async function runAnalyticsIngestion(config: Config): Promise<{ funnelData: FunnelData; problemSet: ProblemSet }> {
  const funnelData = await fetchFunnelData(config)
  const problemSet = classifyProblems(funnelData, config.dropOffThreshold)
  return { funnelData, problemSet }
}

async function fetchFunnelData(config: Config): Promise<FunnelData> {
  const steps = await withRetry(
    () => fetchFunnelSteps(config),
    { label: "PostHog funnel steps", attempts: 3 }
  )

  const [conversionRate, trialCancellationRate, avgSessionTime] = await Promise.all([
    withRetry(() => fetchPaywallConversionRate(config), { label: "PostHog paywall conversion rate" }),
    withRetry(() => fetchTrialCancellationRate(config), { label: "PostHog trial cancellation rate" }),
    withRetry(() => fetchAvgSessionTime(config), { label: "PostHog avg session time" }),
  ])

  return {
    steps,
    trial_cancellation_rate: trialCancellationRate,
    conversion_rate: conversionRate,
    avg_session_time_seconds: avgSessionTime,
  }
}

async function fetchFunnelSteps(config: Config): Promise<FunnelStep[]> {
  const response = await fetch(
    `${config.posthogApiBaseUrl}/api/projects/${config.posthogProjectId}/insights/funnel/`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.posthogApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        insight: "FUNNELS",
        events: NUTRIBOT_FUNNEL_STEPS,
        date_from: "-7d",
        funnel_window_interval: 14,
        funnel_window_interval_unit: "day",
      }),
    }
  )

  if (!response.ok) {
    throw new Error(`PostHog funnel API ${response.status}: ${await response.text()}`)
  }

  const data = (await response.json()) as PostHogFunnelResult
  return buildFunnelSteps(data.result)
}

function buildFunnelSteps(result: PostHogFunnelResult["result"]): FunnelStep[] {
  return result.map((step, idx) => {
    const prevCount = idx === 0 ? step.count : result[idx - 1].count
    const dropOffPct = prevCount > 0 ? 1 - step.count / prevCount : 0
    return {
      name: step.name,
      users: step.count,
      drop_off_pct: Math.round(dropOffPct * 1000) / 1000,
    }
  })
}

// Paywall conversion = started_free_trial / viewed_paywall
async function fetchPaywallConversionRate(config: Config): Promise<number> {
  const [paywallViews, trialStarts] = await Promise.all([
    fetchEventCount(config, "viewed_paywall"),
    fetchEventCount(config, "started_free_trial"),
  ])
  if (paywallViews === 0) return 0.02
  return trialStarts / paywallViews
}

async function fetchTrialCancellationRate(config: Config): Promise<number> {
  const [trialStarts, trialCancels] = await Promise.all([
    fetchEventCount(config, "started_free_trial"),
    fetchEventCount(config, "cancelled_free_trial"),
  ])
  if (trialStarts === 0) return 0.62
  return trialCancels / trialStarts
}

async function fetchEventCount(config: Config, eventId: string): Promise<number> {
  const response = await fetch(
    `${config.posthogApiBaseUrl}/api/projects/${config.posthogProjectId}/insights/?` +
    `events=${encodeURIComponent(JSON.stringify([{ id: eventId }]))}&date_from=-7d`,
    { headers: { Authorization: `Bearer ${config.posthogApiKey}` } }
  )
  if (!response.ok) throw new Error(`PostHog event count API ${response.status} for ${eventId}`)
  const data = (await response.json()) as { result?: { aggregated_value?: number } }
  return data.result?.aggregated_value ?? 0
}

async function fetchAvgSessionTime(config: Config): Promise<number> {
  const response = await fetch(
    `${config.posthogApiBaseUrl}/api/projects/${config.posthogProjectId}/insights/?` +
    `events=${encodeURIComponent(JSON.stringify([{ id: "$pageview" }]))}&date_from=-7d`,
    { headers: { Authorization: `Bearer ${config.posthogApiKey}` } }
  )
  if (!response.ok) throw new Error(`PostHog session time API ${response.status}`)
  const data = (await response.json()) as { result?: { average_session_duration?: number } }
  return data.result?.average_session_duration ?? 120
}

function classifyProblems(data: FunnelData, threshold: number): ProblemSet {
  const types: ProblemType[] = []

  const worstStep = findWorstDropOffStep(data.steps, threshold)
  if (worstStep) types.push("ONBOARDING_FRICTION")

  if (data.trial_cancellation_rate > TRIAL_CANCEL_THRESHOLD) {
    types.push("TRIAL_WEAK_VALUE_PROP")
  }

  if (
    data.conversion_rate < CONVERSION_LOW_THRESHOLD &&
    data.avg_session_time_seconds > HIGH_INTENT_SESSION_THRESHOLD
  ) {
    types.push("HIGH_INTENT_LOW_CONVERT")
  }

  const primary = types.includes("ONBOARDING_FRICTION")
    ? "ONBOARDING_FRICTION"
    : types[0] ?? "ONBOARDING_FRICTION"

  const flaggedStep = worstStep ?? data.steps[1]
  const flaggedStepIndex = data.steps.findIndex((s) => s.name === flaggedStep.name)

  return {
    types,
    primary,
    flagged_step: flaggedStep.name,
    flagged_step_index: Math.max(flaggedStepIndex, 0),
  }
}

function findWorstDropOffStep(steps: FunnelStep[], threshold: number): FunnelStep | null {
  const overThreshold = steps.filter((s) => s.drop_off_pct > DROP_OFF_FRICTION_THRESHOLD)
  if (overThreshold.length === 0) {
    const worst = steps.slice(1).reduce(
      (max, s) => (s.drop_off_pct > max.drop_off_pct ? s : max),
      steps[1]
    )
    return worst.drop_off_pct > threshold ? worst : null
  }
  return overThreshold.reduce((max, s) => (s.drop_off_pct > max.drop_off_pct ? s : max))
}
