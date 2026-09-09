import { describe, expect, test } from "bun:test"
import type { PluginInput, ToolDefinition } from "@opencode-ai/plugin"
import plugin from "../../src/index"

async function loadTool(): Promise<ToolDefinition> {
  const hooks = await plugin.server({} as PluginInput)
  const def = hooks.tool?.gpt_imagegen
  if (!def) throw new Error("gpt_imagegen tool not registered")
  return def
}

// OpenCode does not validate the model's arguments against the zod schema before calling
// execute, so the constraints have to be enforced by the tool itself. Each case fails
// before any auth lookup or network call, which is why no fetch mock is needed.
const ctx = { directory: "/tmp", messageID: "msg_1", abort: new AbortController().signal }

describe("gpt_imagegen.execute", () => {
  test("rejects more reference images than the cap", async () => {
    const tool = await loadTool()
    const images = Array.from({ length: 6 }, (_, i) => `ref-${i}.png`)

    await expect(tool.execute({ prompt: "a cat", out: "cat.png", images }, ctx as never)).rejects.toThrow(/images/)
  })

  test("rejects a size that is not auto or WIDTHxHEIGHT", async () => {
    const tool = await loadTool()

    await expect(tool.execute({ prompt: "a cat", out: "cat.png", size: "1024" }, ctx as never)).rejects.toThrow(/size/)
  })

  test("rejects a size with a zero dimension", async () => {
    const tool = await loadTool()

    await expect(tool.execute({ prompt: "a cat", out: "cat.png", size: "0x1024" }, ctx as never)).rejects.toThrow(
      /size/,
    )
  })
})
