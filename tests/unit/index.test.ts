import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { PluginInput, ToolDefinition } from "@opencode-ai/plugin"
import { MAX_EDIT_IMAGES } from "../../src/codex"
import plugin from "../../src/index"

async function loadTool(): Promise<ToolDefinition> {
  const hooks = await plugin.server({} as PluginInput)
  const def = hooks.tool?.gpt_imagegen
  if (!def) throw new Error("gpt_imagegen tool not registered")
  return def
}

const ctx = { directory: "/tmp", messageID: "msg_1", abort: new AbortController().signal }
const VALID = { prompt: "a cat", out: "cat.png" }

// OpenCode does not validate the model's arguments against the zod schema before calling
// execute, so the constraints have to be enforced by the tool itself. Each case must fail
// before any network call; the fetch guard answers a non-retried 400 so a regression fails
// fast and offline instead of sending a real request with the developer's token.
describe("gpt_imagegen.execute", () => {
  const originalFetch = globalThis.fetch
  const originalAuthContent = process.env.OPENCODE_AUTH_CONTENT
  beforeEach(() => {
    process.env.OPENCODE_AUTH_CONTENT = JSON.stringify({ openai: { type: "oauth", access: "tok" } })
    globalThis.fetch = (async () => new Response("unexpected network call", { status: 400 })) as unknown as typeof fetch
  })
  afterEach(() => {
    globalThis.fetch = originalFetch
    if (originalAuthContent === undefined) delete process.env.OPENCODE_AUTH_CONTENT
    else process.env.OPENCODE_AUTH_CONTENT = originalAuthContent
  })

  test("rejects more reference images than the cap with the accepted bound", async () => {
    const tool = await loadTool()
    const images = Array.from({ length: MAX_EDIT_IMAGES + 1 }, (_, i) => `ref-${i}.png`)

    await expect(tool.execute({ ...VALID, images }, ctx as never)).rejects.toThrow(
      `images must contain at most ${MAX_EDIT_IMAGES} paths`,
    )
  })

  for (const size of ["1024", "0x1024", "1024X1536"]) {
    test(`rejects size "${size}" with the accepted grammar`, async () => {
      const tool = await loadTool()

      await expect(tool.execute({ ...VALID, size }, ctx as never)).rejects.toThrow(
        "size must be `auto` or `WIDTHxHEIGHT`",
      )
    })
  }

  test("treats explicit null size and images as not set", async () => {
    const tool = await loadTool()

    // Validation passes, so the call reaches the guarded network layer.
    await expect(tool.execute({ ...VALID, size: null, images: null }, ctx as never)).rejects.toThrow(
      "image generation failed: http 400: unexpected network call",
    )
  })
})
