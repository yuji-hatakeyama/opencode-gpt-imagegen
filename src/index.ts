import type { Plugin } from "@opencode/plugin/promise/plugin"
import type { PluginModule } from "@opencode-ai/plugin"
import { server } from "./v1"
import { setup } from "./v2"

export default {
  id: "opencode-gpt-imagegen",
  server,
  setup,
} satisfies PluginModule & Plugin
