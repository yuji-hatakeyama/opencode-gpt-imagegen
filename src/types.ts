// Credentials needed by the Codex Images endpoints.
export type OpenAIAuth = { type: "oauth"; access: string; accountId?: string }

export type LoadOpenAIAuth = () => Promise<OpenAIAuth | undefined>

export type ImagegenResult = {
  savedPath: string
  versioned: boolean
  message: string
}
