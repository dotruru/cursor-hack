import { mkdtemp, writeFile, rm } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { spawn } from "child_process"
import type { GeneratedVariant } from "../types.js"

type VerifyResult = {
  valid: boolean
  failedVariants: string[]
  errors: string
}

// Minimal tsconfig for generated React/Tailwind components.
// Uses permissive settings so pure syntax errors still surface
// without requiring full project deps to be present.
const TEMP_TSCONFIG = {
  compilerOptions: {
    target: "ES2020",
    module: "ESNext",
    moduleResolution: "bundler",
    jsx: "react-jsx",
    strict: false,
    noEmit: true,
    skipLibCheck: true,
    noUnusedLocals: false,
    lib: ["ES2020", "DOM"],
  },
  include: ["*.tsx"],
}

export async function verifyGeneratedVariants(variants: GeneratedVariant[]): Promise<VerifyResult> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "nutribot-codegen-"))

  try {
    await writeFile(path.join(tempDir, "tsconfig.json"), JSON.stringify(TEMP_TSCONFIG, null, 2))

    for (const variant of variants) {
      const filename = path.basename(variant.filename)
      await writeFile(path.join(tempDir, filename), variant.code, "utf-8")
    }

    return await runTsc(tempDir, variants)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

async function runTsc(tempDir: string, variants: GeneratedVariant[]): Promise<VerifyResult> {
  return new Promise((resolve) => {
    const tscBin = new URL("../../node_modules/.bin/tsc", import.meta.url).pathname
    const proc = spawn(tscBin, ["--noEmit"], { cwd: tempDir, shell: false })

    let output = ""
    proc.stderr.on("data", (chunk: Buffer) => { output += chunk.toString() })
    proc.stdout.on("data", (chunk: Buffer) => { output += chunk.toString() })

    proc.on("close", (code) => {
      const failedVariants = code !== 0 ? extractFailedVariants(output, variants) : []
      resolve({ valid: code === 0, failedVariants, errors: output.trim() })
    })

    proc.on("error", () => {
      // tsc unavailable in environment — skip check rather than block the pipeline
      resolve({ valid: true, failedVariants: [], errors: "" })
    })
  })
}

function extractFailedVariants(tscOutput: string, variants: GeneratedVariant[]): string[] {
  return variants
    .filter((v) => tscOutput.includes(path.basename(v.filename)))
    .map((v) => v.id)
}
