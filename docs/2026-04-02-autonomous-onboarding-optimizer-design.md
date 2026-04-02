# Autonomous Onboarding Optimizer — Design Spec
**Date:** 2026-04-02
**Scope:** Hackathon POC — single calorie tracking web app (NutriBot)

---

## System Overview

5-stage agent pipeline. Reads PostHog analytics, analyzes competitor screenshots via OpenAI Vision, generates React onboarding variants, deploys via GitHub to Vercel.

```
[CRON / POSTHOG WEBHOOK]
        ↓
Stage 1: ANALYTICS INGESTION
  PostHog REST API → funnel drop-off data → problem classification
        ↓
Stage 2: COMPETITOR RESEARCH
  Pre-cached competitor PNGs → GPT-4o Vision → structured JSON pattern extraction
        ↓
Stage 3: VARIANT GENERATION
  3x React component variants → GPT-4o self-selects best based on drop-off type
        ↓
Stage 4: DEPLOYMENT
  Octokit → branch → commit files → push → Vercel auto-deploys (~25s)
        ↓
Stage 5: VERIFICATION
  PostHog re-poll → delta report → Slack webhook
```

---

## Tech Stack

**NutriBot (target app)**
- Next.js 14 (App Router), Tailwind CSS
- PostHog client SDK for funnel tracking
- Hosted on Vercel, GitHub-connected for auto-deploy

**Agent pipeline**
- TypeScript, Node.js, `tsx` for zero-build execution
- `openai` — GPT-4o Vision + GPT-4o for code generation
- `@octokit/rest` — GitHub branch/commit/push
- `posthog-node` — analytics read
- `sharp` — PNG loading and base64 encoding for Vision API

No agent framework. Linear pipeline, direct SDK calls.

---

## Stage 1: Analytics Ingestion

**Trigger:** Cron every 6 hours OR PostHog webhook when onboarding completion rate drops below threshold (default 30%).

**PostHog API call:** Fetch funnel breakdown by step.

**Output schema:**
```typescript
type FunnelData = {
  steps: { name: string; users: number; drop_off_pct: number }[]
  trial_cancellation_rate: number
  conversion_rate: number
}
```

**Problem classifier — maps data to intervention type:**

| Condition | Problem Type | Intervention |
|-----------|-------------|--------------|
| Any step drop-off >40% | `ONBOARDING_FRICTION` | Redesign that screen |
| Trial cancellation >50% | `TRIAL_WEAK_VALUE_PROP` | Introductory flow before paywall |
| Conversion <15% + session >3min | `HIGH_INTENT_LOW_CONVERT` | Inject lifetime deal at paywall |

Multiple types can fire simultaneously. `ONBOARDING_FRICTION` is resolved first.

**Output:**
```typescript
type ProblemSet = {
  types: ProblemType[]
  primary: ProblemType
  flagged_step: string   // e.g. "enter_details"
  flagged_step_index: number
}
```

---

## Stage 2: Competitor Research

**Screenshot source:** Pre-cached PNGs at `/competitor-screens/calorie-tracking/`. Filenames encode app and step:
```
calai_onboarding_02_details.png
myfitnesspal_onboarding_02.png
noom_onboarding_02_commitment.png
```

Agent selects files matching `*_0{flagged_step_index}_*` glob.

**GPT-4o Vision call:**

Model: `gpt-4o`
Input: base64-encoded PNG + system prompt
Max tokens: 800

System prompt:
```
You are a conversion rate optimization expert.
Analyze this app onboarding screenshot and return JSON only — no explanation.
```

User prompt:
```
Return this exact JSON structure:
{
  "psychological_techniques": [
    { "technique": string, "implementation": string, "conversion_impact": "high|medium|low" }
  ],
  "question_framing": string,
  "friction_reducers": string[],
  "trust_signals": string[],
  "emotional_tone": "aspirational|fear|community|utility"
}
```

Agent runs Vision call for each matched screenshot, aggregates into a `PatternLibrary`:
```typescript
type PatternLibrary = {
  top_techniques: Technique[]   // deduped, sorted by conversion_impact
  dominant_tone: string
  friction_reducers: string[]
  trust_signals: string[]
}
```

---

## Stage 3: Variant Generation

**GPT-4o code generation call:**

Model: `gpt-4o`
Input: `PatternLibrary` + `ProblemSet` + current broken component source
Output: 3 complete React + Tailwind TSX components

### Variant strategies:

**Variant A — Emotional/Aspirational**
Techniques: identity transformation, loss aversion, progress bar, single question per screen.

**Variant B — Social Proof**
Techniques: social validation, tribe belonging, testimonial above fold, community framing.

**Variant C — Utility/Speed**
Techniques: immediate value, minimal fields, "why we ask" tooltips, time-based progress indicator.

### Self-selection logic (GPT-4o reasoning call):

```
if avg_session_time < 45s          → Variant C
if drop_off at goal-setting step   → Variant A
if high traffic, low conversion    → Variant B
default                            → Variant A
```

GPT-4o receives the `ProblemSet`, the three variant outlines, and the decision logic. Returns `{ selected: "A"|"B"|"C", reasoning: string }`.

If `HIGH_INTENT_LOW_CONVERT` is active, agent additionally generates a `LifetimeDeal.tsx` component injected at the paywall step.

**Files generated:**
```
src/components/onboarding/OnboardingStep{N}.tsx   (replaced)
src/components/onboarding/variants/Variant{X}.tsx (new)
src/components/pricing/LifetimeDeal.tsx           (new, if HIGH_INTENT)
src/config/onboarding.config.ts                   (active variant pointer updated)
```

---

## Stage 4: Deployment

**Octokit sequence:**
```
1. GET /repos/{owner}/{repo}/git/ref/heads/main      → get latest SHA
2. POST /repos/{owner}/{repo}/git/blobs              → upload each file (base64)
3. POST /repos/{owner}/{repo}/git/trees              → create tree with new blobs
4. POST /repos/{owner}/{repo}/git/commits            → create commit
5. PATCH /repos/{owner}/{repo}/git/refs/heads/main   → advance main to new commit
```

Direct push to main for demo (no PR). Vercel webhook fires on push, deployment completes in ~25 seconds.

**Commit message format:**
```
agent: replace onboarding step {N} — variant {X} ({tone})

PostHog: {drop_off_pct}% drop-off at {step_name}
Selected: Variant {X} — {reasoning}
Techniques: {top_techniques joined}
```

---

## Stage 5: Verification

PostHog re-poll 24hrs post-deploy (demo: synthetic events pre-seeded to simulate improvement).

**Report schema:**
```typescript
type AgentReport = {
  problem_detected: string
  root_cause: string
  screenshots_analyzed: number
  variant_deployed: "A" | "B" | "C"
  changes: string[]
  metrics: {
    onboarding_completion: { before: number; after: number }
    trial_cancellation:    { before: number; after: number }
    conversion_rate:       { before: number; after: number }
    revenue_per_day:       { before: number; after: number }
  }
}
```

Delivered via POST to Slack webhook.

---

## Environment Variables

```
OPENAI_API_KEY
POSTHOG_API_KEY
POSTHOG_PROJECT_ID
GITHUB_TOKEN
GITHUB_OWNER
GITHUB_REPO
SLACK_WEBHOOK_URL
VERCEL_DEPLOY_HOOK_URL   (optional — Vercel also deploys from GitHub push)
```

---

## Open Questions

1. Who builds NutriBot — separate person/repo?
2. Who sets up PostHog funnel and seeds the bad data?
3. Does the agent run as a local script or deployed (Railway/VPS)?
4. GitHub org for NutriBot repo?
