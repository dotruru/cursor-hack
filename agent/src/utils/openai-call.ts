import type OpenAI from "openai"

// o-series reasoning models use max_completion_tokens (not max_tokens)
// and don't support temperature. o3 supports system messages.
const REASONING_MODEL_PREFIX = /^o[1-9]/

type Message = { role: "system" | "user" | "assistant"; content: string }

type CallOptions = {
  model: string
  messages: Message[]
  maxTokens: number
}

export async function callCompletion(openai: OpenAI, opts: CallOptions): Promise<string> {
  const { model, messages, maxTokens } = opts
  const isReasoning = REASONING_MODEL_PREFIX.test(model)

  if (isReasoning) {
    const response = await openai.chat.completions.create({ model, messages, max_completion_tokens: maxTokens, stream: false })
    return response.choices[0]?.message?.content ?? ""
  }

  const response = await openai.chat.completions.create({ model, messages, max_tokens: maxTokens, temperature: 0.7, stream: false })
  return response.choices[0]?.message?.content ?? ""
}
