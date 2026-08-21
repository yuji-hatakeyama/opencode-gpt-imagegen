// Minimal subset of OpenCode auth.json's openai OAuth entry required by this plugin.
export type OpenAIAuth = { type: "oauth"; access: string; accountId?: string }

// The reference-selection args mirror codex's ImagegenArgs; out/size are plugin
// additions (codex saves to a fixed location and steers size via the prompt).
// https://github.com/openai/codex/blob/9e552e9d15ba52bed7077d5357f3e18e330f8f38/codex-rs/ext/image-generation/src/tool.rs#L83-L91
export type GenerateArgs = {
  prompt: string
  out: string
  size?: string
  referenced_image_paths?: string[]
  num_last_images_to_include?: number
}
