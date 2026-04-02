import { Octokit } from "@octokit/rest"
import type { Config, GeneratedFiles, ProblemSet, DeploymentResult, DeployedFile } from "../types.js"

export async function runDeployment(
  config: Config,
  generatedFiles: GeneratedFiles,
  problemSet: ProblemSet
): Promise<DeploymentResult> {
  const octokit = new Octokit({ auth: config.githubToken })
  const { owner, repo } = { owner: config.githubOwner, repo: config.githubRepo }

  const filesToDeploy = buildFileSet(generatedFiles, problemSet)

  console.log(`[Stage 4] Deploying ${filesToDeploy.length} file(s) to ${owner}/${repo}`)

  const previousCommitSha = await getLatestCommitSha(octokit, owner, repo)
  const blobShas = await uploadBlobs(octokit, owner, repo, filesToDeploy)
  const treeSha = await createTree(octokit, owner, repo, previousCommitSha, filesToDeploy, blobShas)
  const commitSha = await createCommit(octokit, owner, repo, previousCommitSha, treeSha, generatedFiles, problemSet)
  await advanceBranch(octokit, owner, repo, commitSha)

  if (config.vercelDeployHookUrl) {
    await triggerVercelDeploy(config.vercelDeployHookUrl)
  }

  const commitUrl = `https://github.com/${owner}/${repo}/commit/${commitSha}`
  console.log(`[Stage 4] Deployed: ${commitUrl}`)

  return {
    commitSha,
    previousCommitSha,
    commitUrl,
    branch: "main",
    filesDeployed: filesToDeploy.map((f) => f.path),
  }
}

function buildFileSet(generatedFiles: GeneratedFiles, problemSet: ProblemSet): DeployedFile[] {
  const files: DeployedFile[] = []

  // Replace the broken step component with the selected variant's code
  files.push({
    path: generatedFiles.replacedStepFilename,
    content: generatedFiles.replacedStepCode,
  })

  // Write all three variants for reference / future A/B testing
  for (const variant of generatedFiles.variants) {
    files.push({ path: variant.filename, content: variant.code })
  }

  // Update the config pointer to the selected variant
  files.push({
    path: "src/config/onboarding.config.ts",
    content: generatedFiles.configCode,
  })

  // Optional: lifetime deal component
  if (generatedFiles.lifetimeDealCode) {
    files.push({
      path: "src/components/pricing/LifetimeDeal.tsx",
      content: generatedFiles.lifetimeDealCode,
    })
  }

  return files
}

export async function getLatestCommitSha(octokit: Octokit, owner: string, repo: string): Promise<string> {
  const { data } = await octokit.git.getRef({ owner, repo, ref: "heads/main" })
  return data.object.sha
}

async function uploadBlobs(
  octokit: Octokit,
  owner: string,
  repo: string,
  files: DeployedFile[]
): Promise<string[]> {
  return Promise.all(
    files.map(async (file) => {
      const { data } = await octokit.git.createBlob({
        owner,
        repo,
        content: Buffer.from(file.content).toString("base64"),
        encoding: "base64",
      })
      return data.sha
    })
  )
}

async function createTree(
  octokit: Octokit,
  owner: string,
  repo: string,
  baseTreeSha: string,
  files: DeployedFile[],
  blobShas: string[]
): Promise<string> {
  const tree = files.map((file, idx) => ({
    path: file.path,
    mode: "100644" as const,
    type: "blob" as const,
    sha: blobShas[idx],
  }))

  const { data } = await octokit.git.createTree({ owner, repo, base_tree: baseTreeSha, tree })
  return data.sha
}

async function createCommit(
  octokit: Octokit,
  owner: string,
  repo: string,
  parentSha: string,
  treeSha: string,
  generatedFiles: GeneratedFiles,
  problemSet: ProblemSet
): Promise<string> {
  const { selected, reasoning } = generatedFiles.selected
  const stepDropOff = problemSet.flagged_step

  const message = buildCommitMessage(selected, problemSet.flagged_step_index, stepDropOff, reasoning, generatedFiles)

  const { data } = await octokit.git.createCommit({
    owner,
    repo,
    message,
    tree: treeSha,
    parents: [parentSha],
  })
  return data.sha
}

function buildCommitMessage(
  variant: string,
  stepIndex: number,
  stepName: string,
  reasoning: string,
  generatedFiles: GeneratedFiles
): string {
  const tone = generatedFiles.variants.find((v) => v.id === variant)?.id ?? variant
  const lines = [
    `agent: replace onboarding step ${stepIndex} — variant ${variant} (${tone})`,
    "",
    `Selected: Variant ${variant} — ${reasoning}`,
    `Step: ${stepName}`,
  ]

  if (generatedFiles.lifetimeDealCode) {
    lines.push("Also deployed: LifetimeDeal.tsx (HIGH_INTENT_LOW_CONVERT)")
  }

  return lines.join("\n")
}

async function advanceBranch(octokit: Octokit, owner: string, repo: string, commitSha: string): Promise<void> {
  await octokit.git.updateRef({
    owner,
    repo,
    ref: "heads/main",
    sha: commitSha,
    force: false,
  })
}

export async function rollbackDeployment(config: Config, deployment: DeploymentResult): Promise<void> {
  const octokit = new Octokit({ auth: config.githubToken })
  const { owner, repo } = { owner: config.githubOwner, repo: config.githubRepo }

  console.log(`[Rollback] Reverting main to ${deployment.previousCommitSha.slice(0, 8)}`)

  // Force is required to move the ref backwards in history
  await octokit.git.updateRef({
    owner,
    repo,
    ref: "heads/main",
    sha: deployment.previousCommitSha,
    force: true,
  })

  console.log(`[Rollback] main reverted to pre-deploy state`)
}

async function triggerVercelDeploy(hookUrl: string): Promise<void> {
  try {
    const response = await fetch(hookUrl, { method: "POST" })
    if (!response.ok) {
      console.warn(`[Stage 4] Vercel deploy hook returned ${response.status}`)
    }
  } catch (err) {
    console.warn(`[Stage 4] Failed to trigger Vercel deploy hook:`, err)
  }
}
