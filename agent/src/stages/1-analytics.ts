import type { Config, FunnelData, FunnelStep, ProblemSet, ProblemType } from "../types.js"
import { withRetry } from "../utils/retry.js"

const DROP_OFF_FRICTION_THRESHOLD = 0.4
const TRIAL_CANCEL_THRESHOLD = 0.5
const CONVERSION_LOW_THRESHOLD = 0.15
const HIGH_INTENT_SESSION_THRESHOLD = 180 // 3 minutes

// NutriBot onboarding funnel — matches lib/posthog.tsx event names exactly.
// Order defines the expected user journey; drop-off is computed step-to-step.
const FUNNEL_EVENT_SEQUENCE = [
  "clicked_get_started",
  "viewed_goal_selection",
  "viewed_body_stats",
  "viewed_activity_level",
  "viewed_diet_preferences",
  "viewed_your_plan",
  "viewed_paywall",
  "completed_onboarding",
] as const

// Extra events needed for problem classification
const EXTRA_EVENTS = ["started_free_trial", "cancelled_free_trial"] as const

const ALL_TRACKED_EVENTS = [...FUNNEL_EVENT_SEQUENCE, ...EXTRA_EVENTS]

type HogQLResult = {
  results: Array<[string, number]>
  columns: string[]
  error?: string
}

export async function runAnalyticsIngestion(
  config: Config
): Promise<{ funnelData: FunnelData; problemSet: ProblemSet }> {
  const funnelData = await fetchFunnelData(config)
  const problemSet = classifyProblems(funnelData, config.dropOffThreshold)
  return { funnelData, problemSet }
}

async function fetchFunnelData(config: Config): Promise<FunnelData> {
  const eventCounts = await withRetry(() => fetchEventCounts(config), {
    label: "PostHog HogQL event counts",
    attempts: 3,
  })

  const steps = buildFunnelSteps(eventCounts)
  const trialStarts = eventCounts["started_free_trial"] ?? 0
  const trialCancels = eventCounts["cancelled_free_trial"] ?? 0
  const paywallViews = eventCounts["viewed_paywall"] ?? 1

  const conversionRate = trialStarts / Math.max(paywallViews, 1)
  const trialCancellationRate = trialStarts > 0 ? trialCancels / trialStarts : 0

  return {
    steps,
    trial_cancellation_rate: trialCancellationRate,
    conversion_rate: conversionRate,
    avg_session_time_seconds: 120, // PostHog session duration not available via HogQL without session_id join
  }
}

async function fetchEventCounts(config: Config): Promise<Record<string, number>> {
  const eventList = ALL_TRACKED_EVENTS.map((e) => `'${e}'`).join(", ")

  const query = `
    SELECT event, count() AS cnt
    FROM events
    WHERE event IN (${eventList})
      AND timestamp >= now() - INTERVAL 7 DAY
    GROUP BY event
  `.trim()

  const response = await fetch(
    `${config.posthogApiBaseUrl}/api/projects/${config.posthogProjectId}/query/`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.posthogPersonalApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: { kind: "HogQLQuery", query } }),
    }
  )

  if (!response.ok) {
    throw new Error(`PostHog query API ${response.status}: ${await response.text()}`)
  }

  const data = (await response.json()) as HogQLResult

  if (data.error) {
    throw new Error(`PostHog HogQL error: ${data.error}`)
  }

  const counts: Record<string, number> = {}
  for (const [event, count] of data.results) {
    counts[event] = count
  }
  return counts
}

function buildFunnelSteps(counts: Record<string, number>): FunnelStep[] {
  return FUNNEL_EVENT_SEQUENCE.map((event, idx) => {
    const users = counts[event] ?? 0
    const prevUsers = idx === 0 ? users : (counts[FUNNEL_EVENT_SEQUENCE[idx - 1]] ?? users)
    const dropOffPct = prevUsers > 0 ? 1 - users / prevUsers : 0
    return {
      name: event,
      users,
      drop_off_pct: Math.round(Math.max(0, dropOffPct) * 1000) / 1000,
    }
  })
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

  const flaggedStep = worstStep ?? data.steps[data.steps.length - 1]
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
    const candidates = steps.filter((s) => s.drop_off_pct > threshold)
    if (candidates.length === 0) return null
    return candidates.reduce((max, s) => (s.drop_off_pct > max.drop_off_pct ? s : max))
  }
  return overThreshold.reduce((max, s) => (s.drop_off_pct > max.drop_off_pct ? s : max))
}
