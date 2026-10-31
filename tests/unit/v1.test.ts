import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { PNG_BASE64, PNG_BUFFER } from "./fixtures"

let dir: string
let authFile: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "v1-auth-"))
  authFile = path.join(dir, "opencode", "auth.json")
  await mkdir(path.dirname(authFile))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function executeWithAuth(envContent?: string): {
  headers: Record<string, string>[]
  result?: { output: string; metadata: { out: string; versioned: boolean } }
  error?: string
} {
  // xdg-basedir captures XDG_DATA_HOME at import time, so each case needs a fresh process.
  const script = `
    import plugin from ${JSON.stringify(new URL("../../src/index.ts", import.meta.url).href)}
    const headers = []
    globalThis.fetch = async (_url, init) => {
      headers.push(init.headers)
      return new Response(JSON.stringify({ created: 0, data: [{ b64_json: ${JSON.stringify(PNG_BASE64)} }] }))
    }
    const hooks = await plugin.server({})
    try {
      const result = await hooks.tool.gpt_imagegen.execute(
        { prompt: "a cat", out: "cat.png", size: "1672x941" },
        { directory: ${JSON.stringify(dir)} },
      )
      console.log(JSON.stringify({ headers, result }))
    } catch (error) {
      console.log(JSON.stringify({ headers, error: error.message }))
    }
  `
  const child = Bun.spawnSync([process.execPath, "--eval", script], {
    env: { ...process.env, XDG_DATA_HOME: dir, OPENCODE_AUTH_CONTENT: envContent },
    stdout: "pipe",
    stderr: "pipe",
  })
  expect(child.exitCode, child.stderr.toString()).toBe(0)
  return JSON.parse(child.stdout.toString())
}

describe("plugin.server", () => {
  describe("authentication", () => {
    test("uses valid OAuth credentials from OPENCODE_AUTH_CONTENT", async () => {
      const access = "tok-env"
      const accountId = "acct-1"
      const content = JSON.stringify({ openai: { type: "oauth", access, accountId } })

      const response = executeWithAuth(content)

      expect(response.error).toBeUndefined()
      expect(response.headers).toEqual([
        expect.objectContaining({ Authorization: `Bearer ${access}`, "ChatGPT-Account-Id": accountId }),
      ])
      expect(await readFile(path.join(dir, "cat.png"))).toEqual(PNG_BUFFER)
    })

    test("prefers OPENCODE_AUTH_CONTENT over auth.json", async () => {
      const access = "tok-env"
      await writeFile(authFile, JSON.stringify({ openai: { type: "oauth", access: "tok-file" } }))
      const content = JSON.stringify({ openai: { type: "oauth", access } })

      const response = executeWithAuth(content)

      expect(response.error).toBeUndefined()
      expect(response.headers).toEqual([expect.objectContaining({ Authorization: `Bearer ${access}` })])
      expect(await readFile(path.join(dir, "cat.png"))).toEqual(PNG_BUFFER)
    })

    test("uses auth.json when OPENCODE_AUTH_CONTENT is unset", async () => {
      const access = "tok-file"
      await writeFile(authFile, JSON.stringify({ openai: { type: "oauth", access } }))

      const response = executeWithAuth()

      expect(response.error).toBeUndefined()
      expect(response.headers).toEqual([expect.objectContaining({ Authorization: `Bearer ${access}` })])
      expect(await readFile(path.join(dir, "cat.png"))).toEqual(PNG_BUFFER)
    })

    test.each([
      ["the entry is not OAuth", JSON.stringify({ openai: { type: "api", access: "tok" } })],
      ["access is not a string", JSON.stringify({ openai: { type: "oauth", access: 123 } })],
      ["there is no OpenAI entry", JSON.stringify({ anthropic: { type: "oauth", access: "tok" } })],
      ["the content is malformed JSON", "{not json"],
    ])("rejects credentials without an HTTP request when %s", (_condition, content) => {
      const response = executeWithAuth(content)

      expect(response.error).toBe("OpenAI ChatGPT OAuth credentials not configured.")
      expect(response.headers).toEqual([])
    })

    test("does not fall back to valid auth.json when OPENCODE_AUTH_CONTENT is invalid", async () => {
      await writeFile(authFile, JSON.stringify({ openai: { type: "oauth", access: "tok-file" } }))

      const response = executeWithAuth("{not json")

      expect(response.error).toBe("OpenAI ChatGPT OAuth credentials not configured.")
      expect(response.headers).toEqual([])
    })

    test("rejects credentials without an HTTP request when auth.json is malformed", async () => {
      await writeFile(authFile, "{not json")

      const response = executeWithAuth()

      expect(response.error).toBe("OpenAI ChatGPT OAuth credentials not configured.")
      expect(response.headers).toEqual([])
    })

    test("rejects credentials without an HTTP request when auth.json is missing", () => {
      const response = executeWithAuth()

      expect(response.error).toBe("OpenAI ChatGPT OAuth credentials not configured.")
      expect(response.headers).toEqual([])
    })
  })
})
