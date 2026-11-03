import type { PluginModule } from "@opencode-ai/plugin"
import { server } from "./v1"

export default {
  id: "opencode-gpt-imagegen",
  server,
} satisfies PluginModule
