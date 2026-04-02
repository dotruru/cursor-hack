# Autonomous Onboarding Optimizer Agent

An always-on AI agent that reads PostHog analytics, analyzes competitor onboarding screenshots with GPT-4o Vision, generates improved React components with o3, deploys them to GitHub, and screenshots the before/after result — all without human involvement.

**Target app:** [NutriBot](https://nutribot-aris-projects-d27f048a.vercel.app) — a calorie tracking app built in Next.js 15  
**Agent repo:** this repo (`dotruru/cursor-hack`)  
**NutriBot repo:** [dotruru/nutribot](https://github.com/dotruru/nutribot)

---

## What it does

Every 6 hours (or when triggered by a PostHog webhook), the agent runs a 5-stage pipeline:

```
[PostHog webhook / cron every 6h]
          ↓
Stage 1: ANALYTICS INGESTION
  HogQL query → funnel drop-off data → problem classification
          ↓
Stage 2: COMPETITOR RESEARCH
  Cal AI onboarding PNGs → GPT-4o Vision → technique extraction
          ↓
Stage 3: VARIANT GENERATION
  Current screen fetched from GitHub → o3 generates 3 React/Tailwind variants
  → TypeScript compile check → o3 self-selects best variant
          ↓
Stage 4: DEPLOYMENT
  Playwright screenshots NutriBot BEFORE push
  → Octokit commits 5 files to dotruru/nutribot → Vercel auto-deploys (~35s)
  → Playwright screenshots NutriBot AFTER deploy
          ↓
Stage 5: VERIFICATION
  PostHog re-poll → regression detection → rollback if metrics worsen
  → Slack Block Kit report with before/after metrics
```

---

## Demo note — synthetic PostHog dataset

The PostHog project uses a **synthetic seed dataset** ([`seed.ts`](https://github.com/dotruru/nutribot/blob/main/seed.ts) in NutriBot) that deliberately produces bad metrics:

- Onboarding completion: ~4%
- Paywall conversion: ~2–3%
- Trial cancellation: ~85%

Because the seed data is fixed and the post-deploy verification runs immediately (rather than waiting 24 hours for real user behaviour), **the agent detects the same drop-off on every run and keeps improving the same screen**. In a production deployment you would:

1. Wait 24h between deploy and verification
2. Use real user traffic rather than seeded events
3. Let PostHog's funnel data naturally shift as the new variant gets exposure

The agent's pipeline logic is complete and correct — it's the feedback loop closure that's accelerated for demo purposes.

---

## Live dashboard

With the agent running locally:

```
http://localhost:3000
```

Shows the Nutribot analysis dashboard with:
- Per-stage "thinking" (what PostHog found, what competitors showed, why variant X was selected)
- Before / after Playwright screenshots side-by-side
- Metric deltas (onboarding completion, conversion rate, revenue/day)
- Full run history

API endpoints:
- `GET /health` — liveness + last run status
- `GET /runs` — full run history (JSON)
- `GET /report/latest` — latest AgentReport
- `POST /trigger` — manual pipeline trigger
- `POST /webhook` — PostHog action webhook (HMAC-verified)

---

## Tech stack

**Agent** (`agent/`)
- TypeScript, Node.js, `tsx` for zero-build execution
- `openai` — o3 for code generation, GPT-4o for Vision (Stage 2)
- `@octokit/rest` — GitHub blob/tree/commit/push sequence
- `posthog-node` — HogQL query API for funnel data
- `playwright` — headless Chromium for before/after screenshots
- `sharp` — PNG resizing before Vision API calls
- `express` + `node-cron` — always-on webhook server + 6h scheduler

**NutriBot** ([dotruru/nutribot](https://github.com/dotruru/nutribot))
- Next.js 15 (App Router), Tailwind CSS, Framer Motion
- PostHog client SDK — all funnel events in `lib/posthog.tsx`
- Hosted on Vercel, auto-deploys from `main`

---

## Agent pipeline stages in detail

### Stage 1 — Analytics ingestion

Runs a single HogQL query against PostHog EU to get counts for all 8 funnel steps:

```
clicked_get_started → viewed_goal_selection → viewed_body_stats →
viewed_activity_level → viewed_diet_preferences → viewed_your_plan →
viewed_paywall → completed_onboarding
```

Classifies the problem as one or more of:
- `ONBOARDING_FRICTION` — any step with >40% drop-off
- `TRIAL_WEAK_VALUE_PROP` — trial cancellation rate >50%
- `HIGH_INTENT_LOW_CONVERT` — conversion <15% with session time >3min

### Stage 2 — Competitor research

34 Cal AI iOS onboarding screenshots are stored in `competitor-screens/calorie-tracking/`, named with step indices (`calai_onboarding_07_paywall_0.png`). The agent globs for the flagged step index and sends matched PNGs to GPT-4o Vision. It aggregates a `PatternLibrary` of techniques, dominant tone, friction reducers, and trust signals from across all matched screenshots.

### Stage 3 — Variant generation

The agent fetches the current screen source AND `lib/onboarding-types.ts` AND `app/onboarding/page.tsx` live from GitHub. It extracts the exact JSX call site (e.g. `<Paywall data={data} />`) and injects all three into the o3 prompt so the generated components have exactly the right props.

Three variants are generated (Emotional/Aspirational · Social Proof · Utility/Speed), TypeScript-checked against the agent's own `node_modules/@types/react`, then o3 self-selects the best variant based on session time and drop-off pattern.

### Stage 4 — Deployment

Octokit 5-step sequence: `getRef` → `createBlob` (parallel) → `createTree` → `createCommit` → `updateRef`. Pushes to `main` directly. Vercel webhook fires on push, deployment completes in ~25–35 seconds.

Playwright (headless Chromium, 390×844 mobile viewport) screenshots `NUTRIBOT_URL` before the push and again 35 seconds after.

### Stage 5 — Verification

Re-polls PostHog with the same HogQL query. If either onboarding completion or conversion rate regresses by more than 5 percentage points, `rollbackDeployment()` is called — force-pushes the previous commit SHA back to `main`. Sends a Slack Block Kit report either way.

---

## Setup

```bash
cd agent
npm install
npx playwright install chromium
cp .env.example .env
# fill in all values — see .env.example for details
npm start
```

Then trigger a run:
```bash
curl -X POST http://localhost:3000/trigger
```

Or seed PostHog with bad demo data first (uses NutriBot's synthetic dataset format):
```bash
npm run seed
```

### Environment variables

| Variable | Purpose |
|---|---|
| `OPENAI_API_KEY` | OpenAI — used for both o3 (codegen) and GPT-4o (vision) |
| `OPENAI_CODEGEN_MODEL` | Default: `o3` — model for Stage 3 code generation |
| `OPENAI_VISION_MODEL` | Default: `gpt-4o` — model for Stage 2 Vision analysis |
| `POSTHOG_PERSONAL_API_KEY` | `phx_...` — Personal API key for HogQL REST queries |
| `POSTHOG_PROJECT_API_KEY` | `phc_...` — Project API key for event capture (seed script) |
| `POSTHOG_PROJECT_ID` | PostHog project ID (number) |
| `POSTHOG_HOST` | e.g. `https://eu.i.posthog.com` |
| `GITHUB_TOKEN` | Personal access token with `repo` write scope |
| `GITHUB_OWNER` | GitHub username / org owning the NutriBot repo |
| `GITHUB_REPO` | NutriBot repo name (e.g. `nutribot`) |
| `SLACK_WEBHOOK_URL` | Incoming webhook URL for Stage 5 reports |
| `NUTRIBOT_URL` | Live Vercel URL for before/after screenshots |
| `WEBHOOK_SECRET` | HMAC secret for PostHog webhook verification |

---

## Project structure

```
cursor-hack/
├── agent/                          # Agent pipeline
│   ├── src/
│   │   ├── index.ts                # Express server + cron scheduler (always-on)
│   │   ├── pipeline.ts             # Linear 5-stage orchestrator
│   │   ├── run-store.ts            # In-memory run history with PipelineThinking
│   │   ├── types.ts                # Shared TypeScript types
│   │   ├── stages/
│   │   │   ├── 1-analytics.ts      # PostHog HogQL funnel query + problem classifier
│   │   │   ├── 2-competitor-research.ts  # GPT-4o Vision + PatternLibrary
│   │   │   ├── 3-variant-generation.ts   # o3 codegen + TSC verify + self-selection
│   │   │   ├── 4-deployment.ts     # Octokit + Playwright screenshots
│   │   │   └── 5-verification.ts   # PostHog re-poll + rollback + Slack
│   │   └── utils/
│   │       ├── openai-call.ts      # Handles o-series vs gpt-4 API differences
│   │       ├── retry.ts            # withRetry() with linear backoff
│   │       ├── screenshot.ts       # Playwright before/after capture
│   │       └── verify-code.ts      # TSC check on generated variants
│   └── screenshots/                # Before/after PNGs per run (gitignored)
├── competitor-screens/
│   └── calorie-tracking/           # 34 Cal AI iOS onboarding PNGs
│       ├── calai_onboarding_07_paywall_0.png
│       └── ...
└── docs/
    └── 2026-04-02-autonomous-onboarding-optimizer-design.md
```
