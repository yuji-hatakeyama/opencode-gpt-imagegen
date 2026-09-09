// Minimal subset of OpenCode auth.json's openai OAuth entry required by this plugin.
export type OpenAIAuth = { type: "oauth"; access: string; accountId?: string }

// `images` plays the role of codex's `referenced_image_paths`; `out` and `size` are plugin
// additions (codex saves to a fixed location and steers size via the prompt).
// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/ext/image-generation/src/tool.rs#L86-L95
export type GenerateArgs = {
  prompt: string
  out: string
  size?: string
  images?: string[]
}
