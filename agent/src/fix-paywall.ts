import { readFile } from "fs/promises"
import { fileURLToPath } from "url"
import path from "path"
import { Octokit } from "@octokit/rest"

const OWNER = process.env.GITHUB_OWNER!
const REPO  = process.env.GITHUB_REPO!
const TOKEN = process.env.GITHUB_TOKEN!

async function main() {
  const contentPath = path.join(fileURLToPath(import.meta.url), "..", "paywall-content.txt")
  const content = await readFile(contentPath, "utf-8")

  const octokit = new Octokit({ auth: TOKEN })

  const { data: current } = await octokit.repos.getContent({
    owner: OWNER, repo: REPO, path: "app/onboarding/screens/Paywall.tsx",
  }) as { data: { sha: string } }

  await octokit.repos.createOrUpdateFileContents({
    owner: OWNER,
    repo: REPO,
    path: "app/onboarding/screens/Paywall.tsx",
    message: "fix: Paywall accepts OnboardingData — fixes Vercel type error",
    content: Buffer.from(content).toString("base64"),
    sha: current.sha,
  })

  console.log("Paywall.tsx pushed — Vercel build should succeed now")
}

main().catch(console.error)
