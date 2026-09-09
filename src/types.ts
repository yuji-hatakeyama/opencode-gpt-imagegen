// Minimal subset of OpenCode auth.json's openai OAuth entry required by this plugin.
export type OpenAIAuth = { type: "oauth"; access: string; accountId?: string }
