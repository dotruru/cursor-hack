import { readdir, readFile } from "fs/promises"
import path from "path"
import sharp from "sharp"
import OpenAI from "openai"
import type { Config, ProblemSet, ScreenAnalysis, Technique, PatternLibrary, ConversionImpact } from "../types.js"

const VISION_MAX_TOKENS = 800
const IMPACT_RANK: Record<ConversionImpact, number> = { high: 3, medium: 2, low: 1 }

const VISION_SYSTEM_PROMPT = `You are a conversion rate optimization expert.
Analyze this app onboarding screenshot and return JSON only — no explanation.`

const VISION_USER_PROMPT = `Return this exact JSON structure:
{
  "psychological_techniques": [
    { "technique": string, "implementation": string, "conversion_impact": "high|medium|low" }
  ],
  "question_framing": string,
  "friction_reducers": string[],
  "trust_signals": string[],
  "emotional_tone": "aspirational|fear|community|utility"
}`

export async function runCompetitorResearch(
  config: Config,
  problemSet: ProblemSet
): Promise<{ patternLibrary: PatternLibrary; screenshotsAnalyzed: number }> {
  const openai = new OpenAI({ apiKey: config.openaiApiKey })
  const matchedFiles = await findMatchingScreenshots(
    config.competitorScreenshotsDir,
    problemSet.flagged_step_index
  )

  if (matchedFiles.length === 0) {
    console.warn(`[Stage 2] No competitor screenshots matched step index ${problemSet.flagged_step_index}`)
    return { patternLibrary: buildEmptyPatternLibrary(), screenshotsAnalyzed: 0 }
  }

  console.log(`[Stage 2] Analyzing ${matchedFiles.length} competitor screenshot(s)`)

  const analyses = await Promise.all(
    matchedFiles.map((file) => analyzeScreenshot(openai, file))
  )

  const patternLibrary = aggregatePatterns(analyses)
  return { patternLibrary, screenshotsAnalyzed: matchedFiles.length }
}

async function findMatchingScreenshots(screenshotsDir: string, stepIndex: number): Promise<string[]> {
  let entries: string[]
  try {
    entries = await readdir(screenshotsDir)
  } catch {
    console.warn(`[Stage 2] Screenshots directory not found: ${screenshotsDir}`)
    return []
  }

  const paddedIndex = String(stepIndex).padStart(2, "0")
  const matched = entries.filter((name) => name.match(new RegExp(`_0?${paddedIndex}_`)) && name.endsWith(".png"))
  return matched.map((name) => path.join(screenshotsDir, name))
}

async function analyzeScreenshot(openai: OpenAI, filePath: string): Promise<ScreenAnalysis> {
  const base64 = await loadImageAsBase64(filePath)

  const response = await openai.chat.completions.create({
    model: "gpt-4o",
    max_tokens: VISION_MAX_TOKENS,
    messages: [
      { role: "system", content: VISION_SYSTEM_PROMPT },
      {
        role: "user",
        content: [
          { type: "image_url", image_url: { url: `data:image/png;base64,${base64}` } },
          { type: "text", text: VISION_USER_PROMPT },
        ],
      },
    ],
  })

  const raw = response.choices[0]?.message?.content ?? "{}"
  return parseVisionResponse(raw, filePath)
}

async function loadImageAsBase64(filePath: string): Promise<string> {
  const buffer = await readFile(filePath)
  // Resize to cap token usage — Vision API charges per image tile
  const resized = await sharp(buffer).resize(1024, 1024, { fit: "inside", withoutEnlargement: true }).png().toBuffer()
  return resized.toString("base64")
}

function parseVisionResponse(raw: string, filePath: string): ScreenAnalysis {
  try {
    const cleaned = raw.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim()
    return JSON.parse(cleaned) as ScreenAnalysis
  } catch {
    console.warn(`[Stage 2] Failed to parse Vision response for ${path.basename(filePath)}, using empty analysis`)
    return {
      psychological_techniques: [],
      question_framing: "",
      friction_reducers: [],
      trust_signals: [],
      emotional_tone: "utility",
    }
  }
}

function aggregatePatterns(analyses: ScreenAnalysis[]): PatternLibrary {
  const techniqueMap = new Map<string, Technique>()
  const frictionReducers = new Set<string>()
  const trustSignals = new Set<string>()
  const toneCounts = new Map<string, number>()

  for (const analysis of analyses) {
    for (const t of analysis.psychological_techniques) {
      const existing = techniqueMap.get(t.technique)
      // Keep the higher-impact version if seen multiple times
      if (!existing || IMPACT_RANK[t.conversion_impact] > IMPACT_RANK[existing.conversion_impact]) {
        techniqueMap.set(t.technique, t)
      }
    }
    analysis.friction_reducers.forEach((fr) => frictionReducers.add(fr))
    analysis.trust_signals.forEach((ts) => trustSignals.add(ts))
    toneCounts.set(analysis.emotional_tone, (toneCounts.get(analysis.emotional_tone) ?? 0) + 1)
  }

  const top_techniques = Array.from(techniqueMap.values()).sort(
    (a, b) => IMPACT_RANK[b.conversion_impact] - IMPACT_RANK[a.conversion_impact]
  )

  const dominant_tone = [...toneCounts.entries()].reduce(
    (max, [tone, count]) => (count > max[1] ? [tone, count] : max),
    ["utility", 0]
  )[0] as string

  return {
    top_techniques,
    dominant_tone,
    friction_reducers: [...frictionReducers],
    trust_signals: [...trustSignals],
  }
}

function buildEmptyPatternLibrary(): PatternLibrary {
  return {
    top_techniques: [],
    dominant_tone: "aspirational",
    friction_reducers: [],
    trust_signals: [],
  }
}
