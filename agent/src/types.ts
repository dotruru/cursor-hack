// ─── Stage 1 ───────────────────────────────────────────────────────────────

export type FunnelStep = {
  name: string
  users: number
  drop_off_pct: number
}

export type FunnelData = {
  steps: FunnelStep[]
  trial_cancellation_rate: number
  conversion_rate: number
  avg_session_time_seconds: number
}

export type ProblemType =
  | "ONBOARDING_FRICTION"
  | "TRIAL_WEAK_VALUE_PROP"
  | "HIGH_INTENT_LOW_CONVERT"

export type ProblemSet = {
  types: ProblemType[]
  primary: ProblemType
  flagged_step: string
  flagged_step_index: number
}

// ─── Stage 2 ───────────────────────────────────────────────────────────────

export type ConversionImpact = "high" | "medium" | "low"

export type Technique = {
  technique: string
  implementation: string
  conversion_impact: ConversionImpact
}

export type ScreenAnalysis = {
  psychological_techniques: Technique[]
  question_framing: string
  friction_reducers: string[]
  trust_signals: string[]
  emotional_tone: "aspirational" | "fear" | "community" | "utility"
}

export type PatternLibrary = {
  top_techniques: Technique[]
  dominant_tone: string
  friction_reducers: string[]
  trust_signals: string[]
}

// ─── Stage 3 ───────────────────────────────────────────────────────────────

export type VariantId = "A" | "B" | "C"

export type GeneratedVariant = {
  id: VariantId
  filename: string
  code: string
}

export type VariantSelection = {
  selected: VariantId
  reasoning: string
}

export type GeneratedFiles = {
  variants: GeneratedVariant[]
  selected: VariantSelection
  replacedStepFilename: string
  replacedStepCode: string
  configCode: string
  lifetimeDealCode?: string
}

// ─── Stage 4 ───────────────────────────────────────────────────────────────

export type DeployedFile = {
  path: string
  content: string
}

export type DeploymentResult = {
  commitSha: string
  previousCommitSha: string
  commitUrl: string
  branch: string
  filesDeployed: string[]
}

// ─── Stage 5 ───────────────────────────────────────────────────────────────

export type MetricDelta = {
  before: number
  after: number
}

export type AgentReport = {
  problem_detected: string
  root_cause: string
  screenshots_analyzed: number
  variant_deployed: VariantId
  changes: string[]
  metrics: {
    onboarding_completion: MetricDelta
    trial_cancellation: MetricDelta
    conversion_rate: MetricDelta
    revenue_per_day: MetricDelta
  }
}

// ─── Pipeline context ──────────────────────────────────────────────────────

export type PipelineContext = {
  funnelData: FunnelData
  problemSet: ProblemSet
  patternLibrary: PatternLibrary
  screenshotsAnalyzed: number
  generatedFiles: GeneratedFiles
  deployment: DeploymentResult
  report: AgentReport
}

export type Config = {
  openaiApiKey: string
  posthogApiKey: string
  posthogProjectId: string
  githubToken: string
  githubOwner: string
  githubRepo: string
  slackWebhookUrl: string
  vercelDeployHookUrl?: string
  dropOffThreshold: number
  competitorScreenshotsDir: string
}
