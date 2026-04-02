import type { Config, FunnelData, FunnelStep, ProblemSet, ProblemType } from "../types.js"
import { withRetry } from "../utils/retry.js"

const DROP_OFF_FRICTION_THRESHOLD = 0.4
const TRIAL_CANCEL_THRESHOLD = 0.5
const CONVERSION_LOW_THRESHOLD = 0.15
const HIGH_INTENT_SESSION_THRESHOLD = 180 // 3 minutes

// PostHog funnel API returns steps with conversion rates between them.
// We compute drop_off_pct as 1 - (step_n.count / step_n-1.count).
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
    withRetry(() => fetchConversionRate(config), { label: "PostHog conversion rate" }),
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
    `https://app.posthog.com/api/projects/${config.posthogProjectId}/insights/funnel/`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.posthogApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        insight: "FUNNELS",
        events: [
          { id: "onboarding_start", name: "onboarding_start", order: 0 },
          { id: "enter_goals", name: "enter_goals", order: 1 },
          { id: "enter_details", name: "enter_details", order: 2 },
          { id: "enter_diet_preferences", name: "enter_diet_preferences", order: 3 },
          { id: "onboarding_complete", name: "onboarding_complete", order: 4 },
        ],
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

async function fetchConversionRate(config: Config): Promise<number> {
  const response = await fetch(
    `https://app.posthog.com/api/projects/${config.posthogProjectId}/insights/?events=[{"id":"subscription_created"}]&date_from=-7d`,
    { headers: { Authorization: `Bearer ${config.posthogApiKey}` } }
  )
  if (!response.ok) throw new Error(`PostHog conversion rate API ${response.status}`)
  const data = (await response.json()) as { result?: { aggregated_value?: number } }
  return data.result?.aggregated_value ?? 0.12
}

async function fetchTrialCancellationRate(config: Config): Promise<number> {
  const response = await fetch(
    `https://app.posthog.com/api/projects/${config.posthogProjectId}/insights/?events=[{"id":"trial_cancelled"}]&date_from=-7d`,
    { headers: { Authorization: `Bearer ${config.posthogApiKey}` } }
  )
  if (!response.ok) throw new Error(`PostHog trial cancellation API ${response.status}`)
  const data = (await response.json()) as { result?: { aggregated_value?: number } }
  return data.result?.aggregated_value ?? 0.45
}

async function fetchAvgSessionTime(config: Config): Promise<number> {
  const response = await fetch(
    `https://app.posthog.com/api/projects/${config.posthogProjectId}/insights/?events=[{"id":"$pageview"}]&date_from=-7d`,
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

  // ONBOARDING_FRICTION resolves first per spec
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
