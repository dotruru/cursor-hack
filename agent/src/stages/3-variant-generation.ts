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

const CODEGEN_MAX_TOKENS = 4096
const SELECTION_MAX_TOKENS = 512

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

  const currentStepSource = await loadCurrentStepSource(config, problemSet.flagged_step_index)

  console.log(`[Stage 3] Generating 3 React variants for step: ${problemSet.flagged_step}`)
  const rawVariants = await generateVariants(openai, currentStepSource, problemSet, patternLibrary)

  console.log(`[Stage 3] Verifying generated TypeScript`)
  const variants = await verifyAndRepairVariants(rawVariants, problemSet.flagged_step_index)

  console.log(`[Stage 3] Self-selecting best variant`)
  const selection = await selectVariant(openai, funnelData, problemSet, variants)

  const configCode = buildOnboardingConfig(selection.selected, problemSet.flagged_step_index)
  const replacedStepCode = variants.find((v) => v.id === selection.selected)?.code ?? currentStepSource
  const replacedStepFilename = `src/components/onboarding/OnboardingStep${problemSet.flagged_step_index}.tsx`

  const files: GeneratedFiles = {
    variants,
    selected: selection,
    replacedStepFilename,
    replacedStepCode,
    configCode,
  }

  if (problemSet.types.includes("HIGH_INTENT_LOW_CONVERT")) {
    console.log(`[Stage 3] Generating LifetimeDeal component (HIGH_INTENT_LOW_CONVERT active)`)
    files.lifetimeDealCode = await generateLifetimeDeal(openai, patternLibrary)
  }

  return files
}

async function loadCurrentStepSource(config: Config, stepIndex: number): Promise<string> {
  const filePath = path.join(
    process.cwd(),
    "..",
    "nutribot",
    `src/components/onboarding/OnboardingStep${stepIndex}.tsx`
  )
  try {
    return await readFile(filePath, "utf-8")
  } catch {
    // Return a minimal placeholder when the source repo isn't co-located
    return `// OnboardingStep${stepIndex}.tsx — source not found locally, generating fresh component\nexport default function OnboardingStep${stepIndex}() { return <div /> }`
  }
}

async function generateVariants(
  openai: OpenAI,
  currentSource: string,
  problemSet: ProblemSet,
  patternLibrary: PatternLibrary
): Promise<GeneratedVariant[]> {
  const topTechniques = patternLibrary.top_techniques
    .slice(0, 5)
    .map((t) => `• ${t.technique}: ${t.implementation}`)
    .join("\n")

  const prompt = `You are an expert React/Tailwind developer and conversion rate optimizer.

The NutriBot onboarding step "${problemSet.flagged_step}" has a high drop-off rate.

Top competitor techniques to incorporate:
${topTechniques}

Friction reducers: ${patternLibrary.friction_reducers.join(", ")}
Trust signals: ${patternLibrary.trust_signals.join(", ")}
Dominant tone from competitors: ${patternLibrary.dominant_tone}

Generate THREE complete, production-ready React + Tailwind TSX components, one for each strategy below.
Each component must be a self-contained default export named after the variant.
Include all imports. Use Tailwind only (no external UI libs). Mobile-first design.

CURRENT BROKEN COMPONENT (reference for functionality, redesign the UX):
\`\`\`tsx
${currentSource}
\`\`\`

Output EXACTLY this format — three code blocks labeled VARIANT_A, VARIANT_B, VARIANT_C:

### VARIANT_A
Strategy: ${VARIANT_STRATEGIES.A}
\`\`\`tsx
// complete component code
\`\`\`

### VARIANT_B
Strategy: ${VARIANT_STRATEGIES.B}
\`\`\`tsx
// complete component code
\`\`\`

### VARIANT_C
Strategy: ${VARIANT_STRATEGIES.C}
\`\`\`tsx
// complete component code
\`\`\``

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: CODEGEN_MAX_TOKENS,
    messages: [{ role: "user", content: prompt }],
  })

  const raw = response.choices[0]?.message?.content ?? ""
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
      filename: `src/components/onboarding/variants/Variant${id}.tsx`,
      code,
    })
  }

  return variants
}

async function selectVariant(
  openai: OpenAI,
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

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: SELECTION_MAX_TOKENS,
    messages: [{ role: "user", content: prompt }],
  })

  const raw = response.choices[0]?.message?.content ?? '{"selected":"A","reasoning":"default"}'
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

async function generateLifetimeDeal(openai: OpenAI, patternLibrary: PatternLibrary): Promise<string> {
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

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: 2048,
    messages: [{ role: "user", content: prompt }],
  })

  return response.choices[0]?.message?.content?.replace(/```tsx?\n?/g, "").replace(/```\n?/g, "").trim() ?? ""
}

function buildFallbackVariant(id: VariantId, stepIndex: number): string {
  return `import React from "react"

export default function Variant${id}() {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-6 bg-white">
      <h1 className="text-2xl font-bold text-gray-900 mb-4">
        Tell us about yourself
      </h1>
      <p className="text-gray-500 text-sm">Step ${stepIndex} — Variant ${id}</p>
    </div>
  )
}`
}
