/**
 * Seed PostHog with NutriBot synthetic funnel data for the demo.
 * Matches event names from lib/posthog.tsx in dotruru/nutribot exactly.
 *
 * NOTE: The NutriBot repo has its own seed.ts which produces more realistic
 * data (1000 users, proper timestamps). Use that for the primary demo seed.
 * This script is a quick-fire alternative that produces bad-looking metrics
 * immediately (no waiting for PostHog to process).
 *
 * Run: npm run seed
 */
import { PostHog } from "posthog-node"

const POSTHOG_PROJECT_API_KEY = process.env.POSTHOG_PROJECT_API_KEY
if (!POSTHOG_PROJECT_API_KEY) throw new Error("POSTHOG_PROJECT_API_KEY is required")

const POSTHOG_HOST = process.env.POSTHOG_HOST ?? "https://us.i.posthog.com"
const client = new PostHog(POSTHOG_PROJECT_API_KEY, { host: POSTHOG_HOST })

type FunnelStep = { event: string; completionRate: number }

// Funnel matching NutriBot events — designed to show terrible metrics
const FUNNEL_STEPS: FunnelStep[] = [
  { event: "clicked_get_started",      completionRate: 1.00 },
  { event: "viewed_goal_selection",    completionRate: 0.84 },
  { event: "viewed_body_stats",        completionRate: 0.80 },
  { event: "viewed_activity_level",    completionRate: 0.73 },
  { event: "viewed_diet_preferences",  completionRate: 0.69 },
  { event: "viewed_your_plan",         completionRate: 0.63 },
  { event: "viewed_paywall",           completionRate: 0.63 },
  { event: "completed_onboarding",     completionRate: 0.02 }, // 97% drop at paywall
]

const TOTAL_USERS = 500
const PAYWALL_VIEWERS = Math.round(TOTAL_USERS * 0.63)
const TRIAL_STARTERS = Math.round(PAYWALL_VIEWERS * 0.02)
const TRIAL_CANCELS = Math.round(TRIAL_STARTERS * 0.85)

async function seedFunnelEvents(): Promise<void> {
  console.log(`[Seed] Sending ${TOTAL_USERS} synthetic NutriBot user journeys`)
  console.log(`[Seed] Host: ${POSTHOG_HOST}`)

  const userIds = Array.from({ length: TOTAL_USERS }, (_, i) => `demo-user-${Date.now()}-${i}`)

  for (const step of FUNNEL_STEPS) {
    const count = Math.round(TOTAL_USERS * step.completionRate)
    for (const id of userIds.slice(0, count)) {
      client.capture({ distinctId: id, event: step.event, properties: { source: "agent-seed", demo: true } })
    }
    console.log(`[Seed]   ${step.event}: ${count} (${Math.round(step.completionRate * 100)}%)`)
  }

  // Seed trial starts and cancellations for TRIAL_WEAK_VALUE_PROP detection
  for (let i = 0; i < TRIAL_STARTERS; i++) {
    client.capture({ distinctId: `demo-trial-${Date.now()}-${i}`, event: "started_free_trial", properties: { plan: "monthly_9_99", demo: true } })
  }
  for (let i = 0; i < TRIAL_CANCELS; i++) {
    client.capture({ distinctId: `demo-trial-${Date.now()}-${i}`, event: "cancelled_free_trial", properties: { reason: "price_shock", demo: true } })
  }
  console.log(`[Seed]   started_free_trial: ${TRIAL_STARTERS} | cancelled_free_trial: ${TRIAL_CANCELS}`)

  await client.shutdown()
  console.log(`\n[Seed] Done. PostHog will process events within ~60 seconds.`)
  console.log(`[Seed] Then trigger the agent:`)
  console.log(`[Seed]   curl -X POST http://localhost:3000/trigger`)
}

seedFunnelEvents().catch((err) => {
  console.error("[Seed] Error:", err)
  process.exit(1)
})
