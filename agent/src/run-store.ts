import type { AgentReport } from "./types.js"

export type RunStatus = "running" | "completed" | "failed" | "skipped"

export type PipelineThinking = {
  stage1?: {
    funnelSteps: { name: string; users: number; dropOff: number }[]
    worstStep: string
    dropOffPct: number
    problemTypes: string[]
    flaggedStep: string
    conversionRate: number
    trialCancellationRate: number
  }
  stage2?: {
    screenshotsAnalyzed: number
    topTechniques: { name: string; impact: string }[]
    dominantTone: string
    frictionReducers: string[]
    trustSignals: string[]
  }
  stage3?: {
    selectedVariant: string
    reasoning: string
    codeVerified: boolean
    failedVariants: string[]
    lifetimeDealGenerated: boolean
  }
  stage4?: {
    commitSha: string
    commitUrl: string
    filesDeployed: string[]
  }
  stage5?: {
    improved: boolean
    rolledBack: boolean
  }
}

export type ScreenshotPair = {
  beforePath: string | null
  afterPath: string | null
}

export type RunRecord = {
  id: string
  triggeredBy: string
  startedAt: string
  finishedAt?: string
  durationMs?: number
  status: RunStatus
  thinking: PipelineThinking
  screenshots?: ScreenshotPair
  report?: AgentReport
  error?: string
}

const MAX_RUNS = 20
const runs: RunRecord[] = []

export function startRun(triggeredBy: string): RunRecord {
  const record: RunRecord = {
    id: `run-${Date.now()}`,
    triggeredBy,
    startedAt: new Date().toISOString(),
    status: "running",
    thinking: {},
  }
  runs.unshift(record)
  if (runs.length > MAX_RUNS) runs.pop()
  return record
}

export function updateRunThinking(record: RunRecord, partial: Partial<PipelineThinking>): void {
  Object.assign(record.thinking, partial)
}

export function setRunScreenshots(record: RunRecord, screenshots: ScreenshotPair): void {
  record.screenshots = screenshots
}

export function completeRun(record: RunRecord, report: AgentReport): void {
  record.status = "completed"
  record.report = report
  record.finishedAt = new Date().toISOString()
  record.durationMs = Date.now() - new Date(record.startedAt).getTime()
}

export function failRun(record: RunRecord, error: unknown): void {
  record.status = "failed"
  record.error = error instanceof Error ? error.message : String(error)
  record.finishedAt = new Date().toISOString()
  record.durationMs = Date.now() - new Date(record.startedAt).getTime()
}

export function skipRun(triggeredBy: string): void {
  const record: RunRecord = {
    id: `run-${Date.now()}`,
    triggeredBy,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: 0,
    status: "skipped",
    thinking: {},
  }
  runs.unshift(record)
  if (runs.length > MAX_RUNS) runs.pop()
}

export function getLatestRun(): RunRecord | undefined {
  return runs[0]
}

export function getLatestCompletedRun(): RunRecord | undefined {
  return runs.find((r) => r.status === "completed")
}

export function getAllRuns(): RunRecord[] {
  return runs
}
