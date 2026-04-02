const DEFAULT_ATTEMPTS = 3
const DEFAULT_DELAY_MS = 1000

type RetryOptions = {
  attempts?: number
  delayMs?: number
  label?: string
}

export async function withRetry<T>(fn: () => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { attempts = DEFAULT_ATTEMPTS, delayMs = DEFAULT_DELAY_MS, label = "operation" } = options

  let lastError: unknown

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err
      if (attempt < attempts) {
        const waitMs = delayMs * attempt // linear backoff: 1s, 2s, 3s
        console.warn(`[Retry] ${label} failed (${attempt}/${attempts}), retrying in ${waitMs}ms —`, errorMessage(err))
        await sleep(waitMs)
      }
    }
  }

  throw lastError
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
