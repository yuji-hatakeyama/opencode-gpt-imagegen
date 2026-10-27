import type { ImageSize } from "./size"

// Credentials needed by the Codex Images endpoints.
export type OpenAIAuth = { type: "oauth"; access: string; accountId?: string }

export type ImagegenResult = {
  savedPath: string
  versioned: boolean
  message: string
}

export type GenerateArgs = {
  prompt: string
  out: string
  size: ImageSize
  images?: string[] | null
  background?: "opaque" | "transparent" | null
}
