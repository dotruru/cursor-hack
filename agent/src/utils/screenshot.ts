import { mkdir } from "fs/promises"
import path from "path"
import { fileURLToPath } from "url"
import { chromium } from "playwright"

const agentRoot = fileURLToPath(new URL("../../..", import.meta.url))
export const SCREENSHOTS_DIR = path.join(agentRoot, "screenshots")

export type ScreenshotPair = {
  beforePath: string | null
  afterPath: string | null
  beforeBase64: string | null
  afterBase64: string | null
}

export async function captureScreenshot(url: string, outputPath: string): Promise<string | null> {
  let browser
  try {
    await mkdir(path.dirname(outputPath), { recursive: true })

    browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      deviceScaleFactor: 2,
    })
    const page = await context.newPage()

    await page.goto(url, { waitUntil: "networkidle", timeout: 20_000 })

    // Brief pause for animations to settle
    await page.waitForTimeout(1500)

    await page.screenshot({ path: outputPath, fullPage: false })
    console.log(`[Screenshot] Captured: ${outputPath}`)
    return outputPath
  } catch (err) {
    console.warn(`[Screenshot] Failed to capture ${url}:`, err instanceof Error ? err.message : err)
    return null
  } finally {
    await browser?.close()
  }
}

export async function captureBeforeAfter(
  nutriBotUrl: string,
  runId: string,
  deployWaitMs = 35_000
): Promise<ScreenshotPair> {
  const dir = path.join(SCREENSHOTS_DIR, runId)
  await mkdir(dir, { recursive: true })

  const beforePath = path.join(dir, "before.png")
  const afterPath = path.join(dir, "after.png")

  // Before: screenshot current state
  const capturedBefore = await captureScreenshot(nutriBotUrl, beforePath)

  // Wait for Vercel to deploy the new commit
  console.log(`[Screenshot] Waiting ${deployWaitMs / 1000}s for Vercel deploy…`)
  await new Promise((resolve) => setTimeout(resolve, deployWaitMs))

  // After: screenshot updated state
  const capturedAfter = await captureScreenshot(nutriBotUrl, afterPath)

  return {
    beforePath: capturedBefore,
    afterPath: capturedAfter,
    beforeBase64: null,
    afterBase64: null,
  }
}
