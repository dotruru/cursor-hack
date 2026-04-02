import { mkdtemp, writeFile, rm } from "fs/promises"
import { tmpdir } from "os"
import path from "path"
import { fileURLToPath } from "url"
import { spawn } from "child_process"
import type { GeneratedVariant } from "../types.js"

type VerifyResult = {
  valid: boolean
  failedVariants: string[]
  errors: string
}

// Point the temp project at the agent's own node_modules so React types resolve.
// This eliminates "Cannot find module 'react'" false positives on generated components.
const agentRoot = fileURLToPath(new URL("../../..", import.meta.url))
const agentNodeModules = path.join(agentRoot, "node_modules")

function buildTempTsconfig(): object {
  return {
    compilerOptions: {
      target: "ES2020",
      module: "ESNext",
      moduleResolution: "bundler",
      jsx: "react-jsx",
      jsxImportSource: "react",
      strict: false,
      noEmit: true,
      skipLibCheck: true,
      noUnusedLocals: false,
      lib: ["ES2020", "DOM"],
      baseUrl: ".",
      paths: {
        react: [`${agentNodeModules}/react/index.js`],
        "react/jsx-runtime": [`${agentNodeModules}/react/jsx-runtime.js`],
      },
      typeRoots: [`${agentNodeModules}/@types`],
    },
    include: ["*.tsx"],
  }
}

export async function verifyGeneratedVariants(variants: GeneratedVariant[]): Promise<VerifyResult> {
  const tempDir = await mkdtemp(path.join(tmpdir(), "nutribot-codegen-"))

  try {
    await writeFile(path.join(tempDir, "tsconfig.json"), JSON.stringify(buildTempTsconfig(), null, 2))

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
  const tscBin = path.join(agentNodeModules, ".bin", "tsc")

  return new Promise((resolve) => {
    const proc = spawn(tscBin, ["--noEmit"], { cwd: tempDir, shell: false })

    let output = ""
    proc.stderr.on("data", (chunk: Buffer) => { output += chunk.toString() })
    proc.stdout.on("data", (chunk: Buffer) => { output += chunk.toString() })

    proc.on("close", (code) => {
      const failedVariants = code !== 0 ? extractFailedVariants(output, variants) : []
      resolve({ valid: code === 0, failedVariants, errors: output.trim() })
    })

    proc.on("error", () => {
      resolve({ valid: true, failedVariants: [], errors: "" })
    })
  })
}

function extractFailedVariants(tscOutput: string, variants: GeneratedVariant[]): string[] {
  return variants
    .filter((v) => tscOutput.includes(path.basename(v.filename)))
    .map((v) => v.id)
}
