import path from "path"
import crypto from "crypto"
import express from "express"
import cron from "node-cron"
import { runPipeline } from "./pipeline.js"
import { getAllRuns, getLatestRun, getLatestCompletedRun, skipRun } from "./run-store.js"
import type { RunRecord } from "./run-store.js"
import type { Config } from "./types.js"

let isRunning = false

function loadConfig(): Config {
  const required = [
    "OPENAI_API_KEY",
    "POSTHOG_PERSONAL_API_KEY",
    "POSTHOG_PROJECT_API_KEY",
    "POSTHOG_PROJECT_ID",
    "GITHUB_TOKEN",
    "GITHUB_OWNER",
    "GITHUB_REPO",
    "SLACK_WEBHOOK_URL",
  ] as const

  const missing = required.filter((key) => !process.env[key])
  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`)
  }

  return {
    openaiApiKey: process.env.OPENAI_API_KEY!,
    posthogPersonalApiKey: process.env.POSTHOG_PERSONAL_API_KEY!,
    posthogProjectApiKey: process.env.POSTHOG_PROJECT_API_KEY!,
    posthogProjectId: process.env.POSTHOG_PROJECT_ID!,
    posthogApiBaseUrl: derivePostHogApiBaseUrl(process.env.POSTHOG_HOST),
    githubToken: process.env.GITHUB_TOKEN!,
    githubOwner: process.env.GITHUB_OWNER!,
    githubRepo: process.env.GITHUB_REPO!,
    slackWebhookUrl: process.env.SLACK_WEBHOOK_URL!,
    vercelDeployHookUrl: process.env.VERCEL_DEPLOY_HOOK_URL,
    dropOffThreshold: parseFloat(process.env.DROP_OFF_THRESHOLD ?? "0.3"),
    competitorScreenshotsDir: path.resolve(
      process.env.COMPETITOR_SCREENSHOTS_DIR ??
        path.join(process.cwd(), "..", "competitor-screens", "calorie-tracking")
    ),
  }
}

async function triggerPipeline(config: Config, source: string): Promise<void> {
  if (isRunning) {
    console.log(`[Agent] Pipeline already running — skipping trigger from ${source}`)
    skipRun(source)
    return
  }

  isRunning = true
  console.log(`\n[Agent] Pipeline triggered by: ${source}`)

  try {
    await runPipeline(config, source)
  } catch (err) {
    console.error(`[Agent] Pipeline error:`, err)
  } finally {
    isRunning = false
  }
}

// Guards against both missing headers and mismatched buffer lengths,
// both of which would cause timingSafeEqual to throw.
function verifyPostHogSignature(rawBody: string, signatureHeader: string, secret: string): boolean {
  if (!signatureHeader.startsWith("sha256=")) return false
  const expected = `sha256=${crypto.createHmac("sha256", secret).update(rawBody).digest("hex")}`
  const a = Buffer.from(expected)
  const b = Buffer.from(signatureHeader)
  if (a.length !== b.length) return false
  return crypto.timingSafeEqual(a, b)
}

function isDropOffAlert(body: Record<string, unknown>): boolean {
  const hookEvent = (body.hook as Record<string, unknown>)?.event as string | undefined
  const dataEvent = (body.data as Record<string, unknown>)?.event as string | undefined
  return (
    hookEvent === "action_performed" ||
    dataEvent === "onboarding_complete" ||
    body.trigger === "drop_off_alert"
  )
}

// Maps ingestion host → REST API base URL
// eu.i.posthog.com → eu.posthog.com  |  us.i.posthog.com → us.posthog.com
function derivePostHogApiBaseUrl(host?: string): string {
  const trimmed = host?.trim() ?? ""
  if (trimmed.includes("eu.")) return "https://eu.posthog.com"
  if (trimmed.includes("us.")) return "https://us.posthog.com"
  return "https://us.posthog.com"
}

function pct(n: number): string {
  return `${Math.round(n * 100)}%`
}

function fmtDelta(before: number, after: number): string {
  const diff = after - before
  const sign = diff > 0 ? "+" : ""
  return `${sign}${Math.round(diff * 100)}pp`
}

function stageStatusIcon(record: RunRecord, stage: number): string {
  const stageKey = `stage${stage}` as keyof typeof record.thinking
  if (record.thinking[stageKey]) return "✓"
  if (record.status === "running") return "⟳"
  return "○"
}

function buildThinkingSection(record: RunRecord): string {
  const t = record.thinking
  const stages: string[] = []

  // Stage 1
  const s1 = t.stage1
  const s1Icon = stageStatusIcon(record, 1)
  const s1Content = s1 ? `
    <p class="stage-finding">Worst step: <strong>${s1.worstStep.replace(/_/g, " ")}</strong> — ${Math.round(s1.dropOffPct * 100)}% drop-off</p>
    <ul class="stage-bullets">
      ${s1.problemTypes.map((p) => `<li>${p.replace(/_/g, " ").toLowerCase()}</li>`).join("")}
      <li>conversion rate: ${Math.round(s1.conversionRate * 100)}% &nbsp;·&nbsp; trial cancellation: ${Math.round(s1.trialCancellationRate * 100)}%</li>
    </ul>
    <div class="funnel-bars">
      ${s1.funnelSteps.map((step) => `
        <div class="funnel-row">
          <span class="funnel-label">${step.name.replace(/_/g, " ")}</span>
          <div class="funnel-bar-wrap">
            <div class="funnel-bar ${step.dropOff > 0.4 ? "bar-hot" : ""}" style="width:${Math.max(4, Math.round((1 - step.dropOff) * 100))}%"></div>
          </div>
          <span class="funnel-pct ${step.dropOff > 0.4 ? "hot" : ""}">${step.dropOff > 0 ? `−${Math.round(step.dropOff * 100)}%` : "start"}</span>
        </div>`).join("")}
    </div>` : `<p class="stage-pending">Waiting for PostHog data…</p>`

  stages.push(`
    <div class="stage-block ${s1 ? "done" : "pending"}">
      <div class="stage-header"><span class="stage-icon">${s1Icon}</span><span class="stage-title">Stage 1 — PostHog Analytics</span></div>
      ${s1Content}
    </div>`)

  // Stage 2
  const s2 = t.stage2
  const s2Icon = stageStatusIcon(record, 2)
  const s2Content = s2 ? `
    <p class="stage-finding">Analyzed <strong>${s2.screenshotsAnalyzed}</strong> competitor screenshot${s2.screenshotsAnalyzed !== 1 ? "s" : ""} · dominant tone: <strong>${s2.dominantTone}</strong></p>
    <ul class="stage-bullets">
      ${s2.topTechniques.slice(0, 4).map((t) => `<li><span class="impact-${t.impact}">${t.impact}</span> ${t.name}</li>`).join("")}
    </ul>
    ${s2.frictionReducers.length ? `<p class="stage-sub">Friction reducers: ${s2.frictionReducers.join(" · ")}</p>` : ""}` : `<p class="stage-pending">Waiting for competitor analysis…</p>`

  stages.push(`
    <div class="stage-block ${s2 ? "done" : "pending"}">
      <div class="stage-header"><span class="stage-icon">${s2Icon}</span><span class="stage-title">Stage 2 — Competitor Research</span></div>
      ${s2Content}
    </div>`)

  // Stage 3
  const s3 = t.stage3
  const s3Icon = stageStatusIcon(record, 3)
  const variantLabels: Record<string, string> = {
    A: "Emotional / Aspirational",
    B: "Social Proof",
    C: "Utility / Speed",
  }
  const s3Content = s3 ? `
    <p class="stage-finding">Deployed <strong>Variant ${s3.selectedVariant}</strong> — ${variantLabels[s3.selectedVariant] ?? ""}</p>
    <ul class="stage-bullets">
      <li>${s3.reasoning}</li>
      <li>TypeScript check: ${s3.codeVerified ? "passed ✓" : `${s3.failedVariants.length} variant(s) replaced with safe fallback`}</li>
      ${s3.lifetimeDealGenerated ? "<li>LifetimeDeal.tsx generated (HIGH_INTENT_LOW_CONVERT)</li>" : ""}
    </ul>
    <div class="variant-chips">
      ${["A", "B", "C"].map((v) => `<span class="variant-chip ${v === s3.selectedVariant ? "selected" : ""}">${v}</span>`).join("")}
    </div>` : `<p class="stage-pending">Waiting for variant generation…</p>`

  stages.push(`
    <div class="stage-block ${s3 ? "done" : "pending"}">
      <div class="stage-header"><span class="stage-icon">${s3Icon}</span><span class="stage-title">Stage 3 — Variant Generation</span></div>
      ${s3Content}
    </div>`)

  // Stage 4
  const s4 = t.stage4
  const s4Icon = stageStatusIcon(record, 4)
  const s4Content = s4 ? `
    <p class="stage-finding"><a href="${s4.commitUrl}" target="_blank" class="commit-link">commit ${s4.commitSha.slice(0, 8)} ↗</a></p>
    <ul class="stage-bullets">
      ${s4.filesDeployed.map((f) => `<li>${f}</li>`).join("")}
    </ul>` : `<p class="stage-pending">Waiting for GitHub deployment…</p>`

  stages.push(`
    <div class="stage-block ${s4 ? "done" : "pending"}">
      <div class="stage-header"><span class="stage-icon">${s4Icon}</span><span class="stage-title">Stage 4 — GitHub → Vercel</span></div>
      ${s4Content}
    </div>`)

  // Stage 5
  const s5 = t.stage5
  const s5Icon = stageStatusIcon(record, 5)
  const s5Content = s5 ? `
    <ul class="stage-bullets">
      <li>${s5.improved ? "✓ Metrics improved — deployment kept" : "Metrics did not improve"}</li>
      ${s5.rolledBack ? "<li>⚠ Regression detected — automatically rolled back to previous commit</li>" : ""}
    </ul>` : `<p class="stage-pending">Waiting for post-deploy metrics…</p>`

  stages.push(`
    <div class="stage-block ${s5 ? "done" : "pending"}">
      <div class="stage-header"><span class="stage-icon">${s5Icon}</span><span class="stage-title">Stage 5 — Verification</span></div>
      ${s5Content}
    </div>`)

  return stages.join("\n")
}

function buildMetricCards(record: RunRecord | undefined): string {
  if (!record?.report) {
    return `
      <div class="metric-card empty-card"><p>No completed run yet</p></div>`
  }

  const m = record.report.metrics

  const cards = [
    { label: "Onboarding completion", before: m.onboarding_completion.before, after: m.onboarding_completion.after, fmt: (n: number) => pct(n) },
    { label: "Paywall conversion", before: m.conversion_rate.before, after: m.conversion_rate.after, fmt: (n: number) => pct(n) },
    { label: "Trial cancellation", before: m.trial_cancellation.before, after: m.trial_cancellation.after, fmt: (n: number) => pct(n) },
    { label: "Revenue / day", before: m.revenue_per_day.before, after: m.revenue_per_day.after, fmt: (n: number) => `$${Math.round(n)}` },
  ]

  return cards.map(({ label, before, after, fmt }) => {
    const improved = label === "Trial cancellation" ? after < before : after > before
    const delta = label === "Trial cancellation"
      ? `${Math.round((after - before) * 100)}pp`
      : fmtDelta(before, after)
    return `
    <div class="metric-card">
      <div class="metric-after ${improved ? "improved" : "regressed"}">${fmt(after)}</div>
      <div class="metric-label">${label}</div>
      <div class="metric-delta">
        <span class="metric-before">${fmt(before)}</span>
        <span class="metric-arrow">→</span>
        <span class="metric-change ${improved ? "pos" : "neg"}">${delta}</span>
      </div>
    </div>`
  }).join("\n")
}

function buildRunHistoryRows(allRuns: RunRecord[]): string {
  if (allRuns.length === 0) {
    return `<tr><td colspan="5" class="empty-row">No runs yet — agent is waiting for a trigger</td></tr>`
  }
  return allRuns.map((r) => {
    const statusClass = r.status === "completed" ? "ok" : r.status === "failed" ? "err" : r.status === "running" ? "run" : "skip"
    const completion = r.report
      ? `${pct(r.report.metrics.onboarding_completion.before)} → ${pct(r.report.metrics.onboarding_completion.after)}`
      : r.status === "running" ? "in progress…" : "—"
    const variant = r.report?.variant_deployed ?? "—"
    const duration = r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : "…"
    const errorNote = r.error ? `<br><span class="err-note">${r.error.slice(0, 60)}</span>` : ""
    return `<tr>
      <td><span class="badge ${statusClass}">${r.status}</span>${errorNote}</td>
      <td>${r.triggeredBy}</td>
      <td>${r.startedAt.replace("T", " ").slice(0, 19)}</td>
      <td>${duration}</td>
      <td>${completion} ${variant !== "—" ? `<span class="var-badge">Var ${variant}</span>` : ""}</td>
    </tr>`
  }).join("\n")
}

function buildDashboardHtml(): string {
  const allRuns = getAllRuns()
  const latest = allRuns[0]
  const latestCompleted = getLatestCompletedRun()
  const now = new Date().toISOString()

  const runVersion = latestCompleted
    ? `v${allRuns.filter((r) => r.status === "completed").length}.${latestCompleted.id.split("-")[1]?.slice(-4) ?? "0"}`
    : "no runs yet"

  const agentStatus = isRunning
    ? `<span class="status-pill running">● Running</span>`
    : `<span class="status-pill idle">◉ Idle</span>`

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="8">
  <title>NutriBot Onboarding Optimizer</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,wght@0,300;0,400;0,500;0,600;0,700;1,400&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --bg: #dde6d9;
      --card: #ffffff;
      --card-alt: #f4f6f2;
      --accent: #d94f2e;
      --accent-pos: #2c7a4b;
      --accent-neg: #d94f2e;
      --text: #1a1c18;
      --muted: #6b7266;
      --border: #c8d4c4;
      --orange: #e07828;
      --shadow: 0 2px 12px rgba(0,0,0,0.07);
    }

    body {
      font-family: 'DM Sans', system-ui, sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      padding: 2rem;
    }

    /* ── Header ──────────────────────────────────────────────────────── */
    .page-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 2rem;
    }
    .brand { display: flex; align-items: center; gap: 0.75rem; }
    .logo { width: 44px; height: 44px; }
    .brand-text h1 { font-size: 1rem; font-weight: 600; color: var(--muted); letter-spacing: -0.01em; }
    .brand-text p { font-size: 1.2rem; font-weight: 700; color: var(--text); letter-spacing: -0.02em; margin-top: 0.05rem; }
    .header-right { display: flex; align-items: center; gap: 1rem; }
    .status-pill { font-size: 0.75rem; font-weight: 600; padding: 0.3rem 0.75rem; border-radius: 20px; }
    .status-pill.idle { background: #e8ede5; color: var(--muted); }
    .status-pill.running { background: #d4edda; color: #1a6335; animation: pulse 1.5s ease infinite; }
    @keyframes pulse { 0%,100% { opacity: 1 } 50% { opacity: 0.6 } }
    .trigger-form button {
      font-family: inherit; font-size: 0.8rem; font-weight: 500;
      background: var(--text); color: #fff;
      border: none; border-radius: 8px; padding: 0.45rem 1.1rem; cursor: pointer;
    }
    .trigger-form button:hover { opacity: 0.85; }

    /* ── Layout ──────────────────────────────────────────────────────── */
    .layout { display: grid; grid-template-columns: 1fr 280px; gap: 1.5rem; align-items: start; }
    @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } }

    /* ── Analysis card ───────────────────────────────────────────────── */
    .analysis-card {
      background: var(--card);
      border-radius: 16px;
      padding: 2rem;
      box-shadow: var(--shadow);
    }
    .analysis-card h2 { font-size: 1.8rem; font-weight: 700; letter-spacing: -0.03em; line-height: 1.2; margin-bottom: 1.5rem; }

    /* ── Stage blocks ────────────────────────────────────────────────── */
    .stage-block { margin-bottom: 1.25rem; padding-bottom: 1.25rem; border-bottom: 1px solid var(--border); }
    .stage-block:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
    .stage-block.pending { opacity: 0.45; }
    .stage-header { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.6rem; }
    .stage-icon {
      width: 22px; height: 22px; border-radius: 50%;
      background: var(--bg); display: flex; align-items: center; justify-content: center;
      font-size: 0.7rem; font-weight: 700; color: var(--muted); flex-shrink: 0;
      font-family: 'DM Mono', monospace;
    }
    .stage-block.done .stage-icon { background: var(--text); color: #fff; }
    .stage-title { font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); }
    .stage-finding { font-size: 0.9rem; color: var(--text); margin-bottom: 0.5rem; }
    .stage-pending { font-size: 0.85rem; color: var(--muted); font-style: italic; }
    .stage-sub { font-size: 0.75rem; color: var(--muted); margin-top: 0.4rem; }
    .stage-bullets { list-style: none; display: flex; flex-direction: column; gap: 0.25rem; margin-bottom: 0.5rem; }
    .stage-bullets li { font-size: 0.83rem; color: var(--muted); padding-left: 1rem; position: relative; }
    .stage-bullets li::before { content: "·"; position: absolute; left: 0; color: var(--accent); font-weight: 700; }
    .impact-high { color: var(--accent); font-size: 0.7rem; font-weight: 700; text-transform: uppercase; margin-right: 4px; }
    .impact-medium { color: var(--orange); font-size: 0.7rem; font-weight: 700; text-transform: uppercase; margin-right: 4px; }
    .impact-low { color: var(--muted); font-size: 0.7rem; font-weight: 700; text-transform: uppercase; margin-right: 4px; }
    .commit-link { color: var(--text); font-weight: 600; font-family: 'DM Mono', monospace; font-size: 0.85rem; }
    .commit-link:hover { color: var(--accent); }

    /* Funnel bars */
    .funnel-bars { display: flex; flex-direction: column; gap: 0.35rem; margin-top: 0.6rem; }
    .funnel-row { display: grid; grid-template-columns: 130px 1fr 44px; align-items: center; gap: 0.5rem; }
    .funnel-label { font-size: 0.72rem; color: var(--muted); font-family: 'DM Mono', monospace; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .funnel-bar-wrap { background: var(--bg); border-radius: 4px; height: 8px; overflow: hidden; }
    .funnel-bar { height: 100%; background: var(--text); border-radius: 4px; transition: width 0.3s; }
    .funnel-bar.bar-hot { background: var(--accent); }
    .funnel-pct { font-size: 0.7rem; font-family: 'DM Mono', monospace; color: var(--muted); text-align: right; }
    .funnel-pct.hot { color: var(--accent); font-weight: 600; }

    /* Variant chips */
    .variant-chips { display: flex; gap: 0.5rem; margin-top: 0.6rem; }
    .variant-chip {
      width: 32px; height: 32px; border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-size: 0.85rem; font-weight: 700;
      background: var(--bg); color: var(--muted);
    }
    .variant-chip.selected { background: var(--text); color: #fff; }

    /* ── Metric cards ─────────────────────────────────────────────────── */
    .metrics-col { display: flex; flex-direction: column; gap: 1rem; }
    .metric-card {
      background: var(--card);
      border-radius: 16px;
      padding: 1.25rem 1.5rem;
      box-shadow: var(--shadow);
    }
    .empty-card { display: flex; align-items: center; justify-content: center; min-height: 80px; color: var(--muted); font-size: 0.85rem; }
    .metric-after { font-size: 2.4rem; font-weight: 700; color: var(--accent); letter-spacing: -0.04em; line-height: 1; }
    .metric-after.improved { color: var(--accent); }
    .metric-after.regressed { color: #666; }
    .metric-label { font-size: 0.78rem; color: var(--muted); margin-top: 0.3rem; margin-bottom: 0.5rem; }
    .metric-delta { display: flex; align-items: center; gap: 0.4rem; font-size: 0.78rem; font-family: 'DM Mono', monospace; }
    .metric-before { color: var(--muted); }
    .metric-arrow { color: var(--muted); }
    .metric-change.pos { color: var(--accent-pos); font-weight: 600; }
    .metric-change.neg { color: var(--accent-neg); font-weight: 600; }

    /* ── Run history ──────────────────────────────────────────────────── */
    .history-section { margin-top: 1.5rem; }
    .history-section h3 { font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--muted); margin-bottom: 0.75rem; }
    table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
    th { text-align: left; padding: 0.4rem 0.6rem; color: var(--muted); font-weight: 500; border-bottom: 1px solid var(--border); font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em; }
    td { padding: 0.5rem 0.6rem; border-bottom: 1px solid var(--border); color: var(--text); }
    .empty-row { text-align: center; color: var(--muted); padding: 2rem; font-style: italic; }
    .err-note { font-size: 0.7rem; color: var(--accent-neg); font-family: 'DM Mono', monospace; }
    .badge { display: inline-block; padding: 0.15rem 0.55rem; border-radius: 20px; font-size: 0.68rem; font-weight: 700; }
    .badge.ok { background: #d4edda; color: #1a6335; }
    .badge.err { background: #fde8e4; color: #b22a0a; }
    .badge.run { background: #dbeafe; color: #1d4ed8; }
    .badge.skip { background: #f1f1ef; color: #888; }
    .var-badge { font-size: 0.68rem; font-weight: 600; background: var(--bg); border-radius: 4px; padding: 0.1rem 0.4rem; margin-left: 4px; color: var(--muted); }

    .footer { margin-top: 1.5rem; font-size: 0.72rem; color: var(--muted); display: flex; justify-content: space-between; }
    .footer a { color: var(--muted); text-decoration: none; }
    .footer a:hover { text-decoration: underline; }
  </style>
</head>
<body>

  <header class="page-header">
    <div class="brand">
      <svg class="logo" viewBox="0 0 44 44" fill="none" xmlns="http://www.w3.org/2000/svg">
        <ellipse cx="22" cy="24" rx="16" ry="14" fill="#e07828"/>
        <ellipse cx="16" cy="23" rx="3" ry="3.5" fill="#c45e10" opacity="0.5"/>
        <ellipse cx="28" cy="25" rx="2.5" ry="3" fill="#c45e10" opacity="0.4"/>
        <path d="M22 10 C22 10 24 4 28 4 C26 7 24 8 22 10Z" fill="#4a7c3f"/>
      </svg>
      <div class="brand-text">
        <h1>Nutribot analysis based on ${runVersion}</h1>
        <p>Onboarding Optimizer Agent</p>
      </div>
    </div>
    <div class="header-right">
      ${agentStatus}
      <form class="trigger-form" method="POST" action="/trigger">
        <button type="submit">▶ Run now</button>
      </form>
    </div>
  </header>

  <div class="layout">
    <!-- Left: analysis thinking -->
    <div class="analysis-card">
      <h2>Onboarding<br>analysis</h2>
      ${latest ? buildThinkingSection(latest) : `<p style="color:var(--muted);font-style:italic">No runs yet. Click "Run now" or wait for the next scheduled check.</p>`}
    </div>

    <!-- Right: metric cards -->
    <div class="metrics-col">
      ${buildMetricCards(latestCompleted)}
    </div>
  </div>

  <!-- Run history -->
  <div class="history-section">
    <h3>Run history</h3>
    <table>
      <thead>
        <tr>
          <th>Status</th>
          <th>Triggered by</th>
          <th>Started (UTC)</th>
          <th>Duration</th>
          <th>Result</th>
        </tr>
      </thead>
      <tbody>${buildRunHistoryRows(allRuns)}</tbody>
    </table>
  </div>

  <div class="footer">
    <span>Auto-refreshes every 8s · ${now.replace("T", " ").slice(0, 19)} UTC</span>
    <span>
      <a href="/runs">JSON history</a> ·
      <a href="/report/latest">latest report</a> ·
      <a href="/health">health</a>
    </span>
  </div>

</body>
</html>`
}

function startWebhookServer(config: Config): void {
  const app = express()
  const port = parseInt(process.env.PORT ?? "3000", 10)
  const webhookSecret = process.env.WEBHOOK_SECRET ?? ""

  app.use(express.json({
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: string }).rawBody = buf.toString()
    },
  }))

  // ── Dashboard ─────────────────────────────────────────────────────────────
  app.get("/", (_req, res) => {
    res.setHeader("Content-Type", "text/html")
    res.send(buildDashboardHtml())
  })

  // ── Health ─────────────────────────────────────────────────────────────────
  app.get("/health", (_req, res) => {
    const latest = getLatestRun()
    res.json({
      status: "ok",
      running: isRunning,
      lastRunAt: latest?.startedAt ?? null,
      lastRunStatus: latest?.status ?? null,
      totalRuns: getAllRuns().length,
      timestamp: new Date().toISOString(),
    })
  })

  // ── Run history ────────────────────────────────────────────────────────────
  app.get("/runs", (_req, res) => {
    res.json(getAllRuns())
  })

  // ── Latest report ──────────────────────────────────────────────────────────
  app.get("/report/latest", (_req, res) => {
    const latest = getAllRuns().find((r) => r.status === "completed")
    if (!latest?.report) {
      res.status(404).json({ error: "No completed runs yet" })
      return
    }
    res.json({ runId: latest.id, startedAt: latest.startedAt, durationMs: latest.durationMs, report: latest.report })
  })

  // ── Manual trigger ─────────────────────────────────────────────────────────
  app.post("/trigger", (_req, res) => {
    res.json({ accepted: true, message: "Pipeline triggered manually" })
    triggerPipeline(config, "manual (HTTP /trigger)").catch(console.error)
  })

  // ── PostHog webhook ────────────────────────────────────────────────────────
  app.post("/webhook", (req, res) => {
    if (webhookSecret) {
      const signatureHeader = (req.headers["x-posthog-signature"] as string) ?? ""
      const rawBody = (req as express.Request & { rawBody?: string }).rawBody ?? ""
      if (!verifyPostHogSignature(rawBody, signatureHeader, webhookSecret)) {
        console.warn("[Webhook] Invalid signature — request rejected")
        res.status(401).json({ error: "Invalid signature" })
        return
      }
    }

    const body = req.body as Record<string, unknown>

    if (!isDropOffAlert(body)) {
      res.json({ ignored: true, reason: "Not a drop-off alert" })
      return
    }

    res.json({ accepted: true, message: "Pipeline queued" })
    triggerPipeline(config, "PostHog webhook").catch(console.error)
  })

  app.listen(port, () => {
    console.log(`[Agent] Server listening on port ${port}`)
    console.log(`[Agent]   GET  /          — live dashboard`)
    console.log(`[Agent]   GET  /health    — liveness + last run status`)
    console.log(`[Agent]   GET  /runs      — full run history (JSON)`)
    console.log(`[Agent]   GET  /report/latest — latest AgentReport (JSON)`)
    console.log(`[Agent]   POST /trigger   — manual pipeline trigger`)
    console.log(`[Agent]   POST /webhook   — PostHog action webhook`)
  })
}

function startCronScheduler(config: Config): void {
  cron.schedule("0 */6 * * *", () => {
    triggerPipeline(config, "cron (6h schedule)").catch(console.error)
  })
  console.log("[Agent] Cron scheduler started — runs every 6 hours (0 */6 * * *)")
}

function main(): void {
  const config = loadConfig()
  startWebhookServer(config)
  startCronScheduler(config)
  console.log("[Agent] Always-on agent running. Waiting for triggers...")
}

main()
