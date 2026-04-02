import { readFile } from "fs/promises"
import path from "path"
import OpenAI from "openai"
import type {
  Config,
  FunnelData,
  PatternLibrary,
  ProblemSet,
  GeneratedFiles,
  GeneratedVariant,
  VariantId,
  VariantSelection,
} from "../types.js"
import { verifyGeneratedVariants } from "../utils/verify-code.js"
import { callCompletion } from "../utils/openai-call.js"

const CODEGEN_MAX_TOKENS = 8192   // o3 benefits from higher token budget for complete components
const SELECTION_MAX_TOKENS = 1024

// NutriBot step index → screen component name (matches app/onboarding/screens/)
const STEP_SCREEN_MAP: Record<number, string> = {
  0: "Welcome",
  1: "GoalSelection",
  2: "BodyStats",
  3: "ActivityLevel",
  4: "DietPreferences",
  5: "YourPlan",
  6: "Paywall",
  7: "Paywall", // completed_onboarding drop-off is fixed by improving the Paywall screen
}

// Variant strategy descriptions fed to GPT-4o so it can generate appropriately themed code
const VARIANT_STRATEGIES: Record<VariantId, string> = {
  A: "Emotional/Aspirational — identity transformation framing, loss aversion copy, animated progress bar, one question per screen, before/after language",
  B: "Social Proof — testimonial above the fold, tribe/community framing, '10,000+ people like you' social validation, community belonging language",
  C: "Utility/Speed — minimal fields only, immediate value statement up top, 'why we ask' tooltip on each input, time-based progress indicator ('30 seconds left')",
}

export async function runVariantGeneration(
  config: Config,
  funnelData: FunnelData,
  problemSet: ProblemSet,
  patternLibrary: PatternLibrary
): Promise<GeneratedFiles> {
  const openai = new OpenAI({ apiKey: config.openaiApiKey })

  const stepContext = await loadStepContext(config, problemSet.flagged_step_index)
  console.log(`[Stage 3] Call signature from page.tsx: ${stepContext.callSignature}`)

  console.log(`[Stage 3] Generating 3 React variants for step: ${problemSet.flagged_step} (model: ${config.openaiCodegenModel})`)
  const rawVariants = await generateVariants(openai, config.openaiCodegenModel, stepContext, problemSet, patternLibrary)

  console.log(`[Stage 3] Verifying generated TypeScript`)
  const variants = await verifyAndRepairVariants(rawVariants, problemSet.flagged_step_index)

  console.log(`[Stage 3] Self-selecting best variant`)
  const selection = await selectVariant(openai, config.openaiCodegenModel, funnelData, problemSet, variants)

  const configCode = buildOnboardingConfig(selection.selected, problemSet.flagged_step_index)
  const screenName = STEP_SCREEN_MAP[problemSet.flagged_step_index] ?? `Screen${problemSet.flagged_step_index}`
  const selectedCode = variants.find((v) => v.id === selection.selected)?.code ?? stepContext.currentSource
  // Guarantee the deployed file has the correct named export the app imports
  const replacedStepCode = ensureNamedExport(selectedCode, screenName)
  const replacedStepFilename = `app/onboarding/screens/${screenName}.tsx`

  const files: GeneratedFiles = {
    variants,
    selected: selection,
    replacedStepFilename,
    replacedStepCode,
    configCode,
  }

  if (problemSet.types.includes("HIGH_INTENT_LOW_CONVERT")) {
    console.log(`[Stage 3] Generating LifetimeDeal component (HIGH_INTENT_LOW_CONVERT active)`)
    files.lifetimeDealCode = await generateLifetimeDeal(openai, config.openaiCodegenModel, patternLibrary)
  }

  return files
}

type StepContext = {
  currentSource: string
  onboardingTypes: string
  callSignature: string  // how page.tsx renders this specific screen
}

async function fetchGitHubFile(config: Config, filePath: string): Promise<string | null> {
  try {
    const url = `https://api.github.com/repos/${config.githubOwner}/${config.githubRepo}/contents/${filePath}`
    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${config.githubToken}`,
        Accept: "application/vnd.github.v3+json",
      },
    })
    if (!response.ok) return null
    const data = (await response.json()) as { content: string; encoding: string }
    if (data.encoding === "base64") {
      return Buffer.from(data.content.replace(/\n/g, ""), "base64").toString("utf-8")
    }
    return null
  } catch {
    return null
  }
}

// Extract the JSX line in page.tsx that renders the given component
function extractCallSignature(pageSource: string, screenName: string): string {
  const lines = pageSource.split("\n")
  const line = lines.find((l) => l.includes(`<${screenName}`) && !l.includes("import"))
  return line?.trim() ?? `<${screenName} data={data} onNext={goNext} onBack={goBack} />`
}

async function loadStepContext(config: Config, stepIndex: number): Promise<StepContext> {
  const screenName = STEP_SCREEN_MAP[stepIndex] ?? `Screen${stepIndex}`
  const screenPath = `app/onboarding/screens/${screenName}.tsx`

  // Try local first, then GitHub
  let currentSource: string | null = null
  const localPath = path.join(process.cwd(), "..", "nutribot", screenPath)
  try {
    currentSource = await readFile(localPath, "utf-8")
  } catch {
    currentSource = await fetchGitHubFile(config, screenPath)
  }

  const [onboardingTypes, pageSource] = await Promise.all([
    fetchGitHubFile(config, "lib/onboarding-types.ts"),
    fetchGitHubFile(config, "app/onboarding/page.tsx"),
  ])

  const callSignature = pageSource ? extractCallSignature(pageSource, screenName) : `<${screenName} data={data} />`

  return {
    currentSource: currentSource ?? buildMinimalPlaceholder(screenName),
    onboardingTypes: onboardingTypes ?? "",
    callSignature,
  }
}

function buildMinimalPlaceholder(screenName: string): string {
  return `"use client"
import React from "react"
import type { OnboardingData } from "@/lib/onboarding-types"

type Props = { data: OnboardingData; onNext: () => void; onBack: () => void }

export function ${screenName}({ onNext }: Props) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-white">
      <button onClick={onNext} className="mt-6 w-full bg-black text-white py-3 rounded-xl">
        Continue
      </button>
    </div>
  )
}`
}

async function generateVariants(
  openai: OpenAI,
  model: string,
  stepContext: StepContext,
  problemSet: ProblemSet,
  patternLibrary: PatternLibrary
): Promise<GeneratedVariant[]> {
  const screenName = STEP_SCREEN_MAP[problemSet.flagged_step_index] ?? "Screen"
  const topTechniques = patternLibrary.top_techniques
    .slice(0, 5)
    .map((t) => `• ${t.technique}: ${t.implementation}`)
    .join("\n")

  const typesBlock = stepContext.onboardingTypes
    ? `\nSHARED TYPES (DO NOT REDEFINE — import from "@/lib/onboarding-types"):
\`\`\`ts
${stepContext.onboardingTypes}
\`\`\``
    : ""

  const prompt = `You are an expert React/Tailwind developer and conversion rate optimizer.

The NutriBot onboarding step "${problemSet.flagged_step}" has a 95%+ drop-off rate.

Top competitor techniques to incorporate:
${topTechniques}

Friction reducers: ${patternLibrary.friction_reducers.join(", ")}
Trust signals: ${patternLibrary.trust_signals.join(", ")}
Dominant tone: ${patternLibrary.dominant_tone}
${typesBlock}

EXACT CALL SITE — page.tsx renders this component as:
  ${stepContext.callSignature}
Your component's props MUST match this call site exactly. Do NOT add or remove props.

CURRENT COMPONENT (preserve its props interface and imports, redesign the UX):
\`\`\`tsx
${stepContext.currentSource}
\`\`\`

RULES:
1. NAMED export only: export function ${screenName}(...)  — never export default
2. Import OnboardingData from "@/lib/onboarding-types" if data prop is used
3. "use client" directive at top of every file
4. Tailwind only, mobile-first, no external UI libraries
5. Props must match the call site above exactly

Generate THREE complete components:

### VARIANT_A
Strategy: ${VARIANT_STRATEGIES.A}
\`\`\`tsx
"use client"
// full component — export function ${screenName}(...)
\`\`\`

### VARIANT_B
Strategy: ${VARIANT_STRATEGIES.B}
\`\`\`tsx
"use client"
// full component — export function ${screenName}(...)
\`\`\`

### VARIANT_C
Strategy: ${VARIANT_STRATEGIES.C}
\`\`\`tsx
"use client"
// full component — export function ${screenName}(...)
\`\`\``

  const raw = await callCompletion(openai, {
    model,
    messages: [{ role: "user", content: prompt }],
    maxTokens: CODEGEN_MAX_TOKENS,
  })
  return parseVariants(raw, problemSet.flagged_step_index)
}

async function verifyAndRepairVariants(variants: GeneratedVariant[], stepIndex: number): Promise<GeneratedVariant[]> {
  const result = await verifyGeneratedVariants(variants)

  if (result.valid) {
    console.log(`[Stage 3] All variants passed TypeScript check`)
    return variants
  }

  console.warn(`[Stage 3] TypeScript errors in variants [${result.failedVariants.join(", ")}] — replacing with safe fallbacks`)
  if (result.errors) console.warn(result.errors)

  return variants.map((v) =>
    result.failedVariants.includes(v.id) ? { ...v, code: buildFallbackVariant(v.id, stepIndex) } : v
  )
}

function parseVariants(raw: string, stepIndex: number): GeneratedVariant[] {
  const variants: GeneratedVariant[] = []
  const ids: VariantId[] = ["A", "B", "C"]

  for (const id of ids) {
    const pattern = new RegExp(`### VARIANT_${id}[\\s\\S]*?\`\`\`tsx([\\s\\S]*?)\`\`\``, "i")
    const match = raw.match(pattern)
    const code = match?.[1]?.trim() ?? buildFallbackVariant(id, stepIndex)
    variants.push({
      id,
      filename: `app/onboarding/screens/variants/Variant${id}.tsx`,
      code,
    })
  }

  return variants
}

async function selectVariant(
  openai: OpenAI,
  model: string,
  funnelData: FunnelData,
  problemSet: ProblemSet,
  variants: GeneratedVariant[]
): Promise<VariantSelection> {
  const prompt = `You are selecting the best onboarding variant to deploy for NutriBot.

Problem type: ${problemSet.primary}
Flagged step: ${problemSet.flagged_step}
Avg session time: ${funnelData.avg_session_time_seconds}s
Drop-off at step: ${problemSet.flagged_step}

Selection logic:
- If avg_session_time < 45s → prefer Variant C (utility/speed)
- If drop-off is at goal-setting step → prefer Variant A (aspirational)
- If high traffic, low conversion → prefer Variant B (social proof)
- Default → Variant A

Variant summaries:
A: ${VARIANT_STRATEGIES.A}
B: ${VARIANT_STRATEGIES.B}
C: ${VARIANT_STRATEGIES.C}

Return JSON only:
{ "selected": "A" | "B" | "C", "reasoning": "one sentence" }`

  const raw = await callCompletion(openai, {
    model,
    messages: [{ role: "user", content: prompt }],
    maxTokens: SELECTION_MAX_TOKENS,
  })
  return parseSelection(raw, funnelData, problemSet)
}

function parseSelection(raw: string, funnelData: FunnelData, problemSet: ProblemSet): VariantSelection {
  try {
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim()
    const parsed = JSON.parse(cleaned) as VariantSelection
    if (["A", "B", "C"].includes(parsed.selected)) return parsed
  } catch {
    // fall through to rule-based fallback
  }
  return applySelectionRules(funnelData, problemSet)
}

function applySelectionRules(funnelData: FunnelData, problemSet: ProblemSet): VariantSelection {
  if (funnelData.avg_session_time_seconds < 45) {
    return { selected: "C", reasoning: "Short session time suggests users want a faster, simpler flow" }
  }
  if (problemSet.flagged_step.includes("goal")) {
    return { selected: "A", reasoning: "Goal-setting step benefits from aspirational identity framing" }
  }
  if (funnelData.conversion_rate < 0.1) {
    return { selected: "B", reasoning: "Low conversion with existing traffic suggests social proof needed" }
  }
  return { selected: "A", reasoning: "Default aspirational variant chosen" }
}

function buildOnboardingConfig(selectedVariant: VariantId, stepIndex: number): string {
  return `// Auto-generated by onboarding optimizer agent
// Do not edit manually — changes will be overwritten on next agent run

export const onboardingConfig = {
  activeVariant: "${selectedVariant}" as const,
  flaggedStepIndex: ${stepIndex},
  lastUpdated: "${new Date().toISOString()}",
} satisfies OnboardingConfig

type OnboardingConfig = {
  activeVariant: "A" | "B" | "C"
  flaggedStepIndex: number
  lastUpdated: string
}
`
}

async function generateLifetimeDeal(openai: OpenAI, model: string, patternLibrary: PatternLibrary): Promise<string> {
  const prompt = `Generate a LifetimeDeal.tsx React + Tailwind component for a calorie tracking app (NutriBot).

This is shown at the paywall for high-intent users who haven't converted.
Trust signals to incorporate: ${patternLibrary.trust_signals.slice(0, 3).join(", ")}

Requirements:
- Prominent "one-time payment" lifetime deal offer (e.g. $49 vs $9.99/mo)
- Urgency element (countdown timer or limited spots)
- Value prop list (5 bullet points)
- Single CTA button "Get Lifetime Access"
- Tailwind only, mobile-first, default export named LifetimeDeal

Return only the TSX code, no markdown fences.`

  const raw = await callCompletion(openai, {
    model,
    messages: [{ role: "user", content: prompt }],
    maxTokens: 2048,
  })
  return raw.replace(/```tsx?\n?/g, "").replace(/```\n?/g, "").trim()
}

// If the LLM still generates a default export, rewrite it to a named export.
// NutriBot imports all screens as named exports: import { Paywall } from "./screens/Paywall"
function ensureNamedExport(code: string, componentName: string): string {
  // Replace: export default function Foo  →  export function Foo
  // Replace: export default function(     →  export function ComponentName(
  // Replace: const Foo = ... ; export default Foo  →  export function Foo (handled by fallback)
  return code
    .replace(/export\s+default\s+function\s+\w+/, `export function ${componentName}`)
    .replace(/export\s+default\s+function\s*\(/, `export function ${componentName}(`)
}

function buildFallbackVariant(id: VariantId, stepIndex: number): string {
  const screenName = STEP_SCREEN_MAP[stepIndex] ?? `Screen${stepIndex}`
  return `"use client"
import React from "react"

type Props = { onNext: () => void; onBack?: () => void }

export function ${screenName}({ onNext }: Props) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-white">
      <h1 className="text-2xl font-bold text-gray-900 mb-4 text-center">
        Your personalized plan is ready
      </h1>
      <p className="text-gray-500 text-sm mb-8 text-center">Variant ${id} — Step ${stepIndex}</p>
      <button
        onClick={onNext}
        className="w-full bg-black text-white py-4 rounded-2xl font-semibold text-lg"
      >
        Get Started
      </button>
    </div>
  )
}`
}
