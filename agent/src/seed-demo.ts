/**
 * Seed PostHog with synthetic funnel events that simulate a broken onboarding flow.
 * Run once before the demo: npm run seed
 *
 * Simulates 200 users starting onboarding, with ~65% dropping off at enter_details
 * — high enough to trigger the ONBOARDING_FRICTION problem type.
 */
import { PostHog } from "posthog-node"

const POSTHOG_API_KEY = process.env.POSTHOG_API_KEY
if (!POSTHOG_API_KEY) throw new Error("POSTHOG_API_KEY is required")

const client = new PostHog(POSTHOG_API_KEY, { host: "https://app.posthog.com" })

type FunnelStep = { event: string; completionRate: number }

const FUNNEL_STEPS: FunnelStep[] = [
  { event: "onboarding_start",        completionRate: 1.0  },
  { event: "enter_goals",             completionRate: 0.82 },
  { event: "enter_details",           completionRate: 0.31 }, // <-- 65% drop-off here
  { event: "enter_diet_preferences",  completionRate: 0.28 },
  { event: "onboarding_complete",     completionRate: 0.25 },
]

const TOTAL_USERS = 200

async function seedFunnelEvents(): Promise<void> {
  console.log(`[Seed] Sending ${TOTAL_USERS} synthetic user journeys to PostHog`)
  console.log(`[Seed] Simulating 65% drop-off at "enter_details" step`)

  const userIds = Array.from({ length: TOTAL_USERS }, (_, i) => `demo-user-${i + 1}`)

  for (const step of FUNNEL_STEPS) {
    const usersCompletingStep = Math.round(TOTAL_USERS * step.completionRate)
    const usersForStep = userIds.slice(0, usersCompletingStep)

    for (const distinctId of usersForStep) {
      client.capture({
        distinctId,
        event: step.event,
        properties: {
          $current_url: `https://nutribot.app/onboarding/${step.event.replace(/_/g, "-")}`,
          source: "seed-demo",
          demo: true,
        },
      })
    }

    console.log(`[Seed]   ${step.event}: ${usersCompletingStep}/${TOTAL_USERS} users (${Math.round(step.completionRate * 100)}%)`)
  }

  // Also seed some trial cancellations and non-conversions to trigger multiple problem types
  const trialStartUsers = Math.round(TOTAL_USERS * 0.25)
  const trialCancelUsers = Math.round(trialStartUsers * 0.55)

  for (let i = 0; i < trialCancelUsers; i++) {
    client.capture({
      distinctId: `demo-trial-user-${i + 1}`,
      event: "trial_cancelled",
      properties: { source: "seed-demo", demo: true, days_into_trial: Math.floor(Math.random() * 7) + 1 },
    })
  }
  console.log(`[Seed]   trial_cancelled: ${trialCancelUsers} users (55% of trial starters)`)

  await client.shutdown()
  console.log(`\n[Seed] Done. PostHog will show funnel data within ~1 minute.`)
  console.log(`[Seed] Trigger the agent with: curl -X POST http://localhost:3000/webhook -H 'Content-Type: application/json' -d '{"trigger":"drop_off_alert"}'`)
}

seedFunnelEvents().catch((err) => {
  console.error("[Seed] Error:", err)
  process.exit(1)
})
