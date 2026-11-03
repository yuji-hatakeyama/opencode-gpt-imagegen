import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { loadOpenAIAuth } from "../../src/v1-auth"

let dir: string
let authFile: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "v1-auth-"))
  authFile = path.join(dir, "auth.json")
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("loadOpenAIAuth", () => {
  test("uses valid OAuth credentials from OPENCODE_AUTH_CONTENT", async () => {
    const auth = { type: "oauth", access: "tok-env", accountId: "acct-1" } as const
    const content = JSON.stringify({ openai: auth })

    const result = await loadOpenAIAuth(content, authFile)

    expect(result).toEqual(auth)
  })

  test("prefers OPENCODE_AUTH_CONTENT over auth.json", async () => {
    const auth = { type: "oauth", access: "tok-env", accountId: "acct-1" } as const
    await writeFile(authFile, JSON.stringify({ openai: { type: "oauth", access: "tok-file" } }))
    const content = JSON.stringify({ openai: auth })

    const result = await loadOpenAIAuth(content, authFile)

    expect(result).toEqual(auth)
  })

  test("uses auth.json when OPENCODE_AUTH_CONTENT is unset", async () => {
    const auth = { type: "oauth", access: "tok-file" } as const
    await writeFile(authFile, JSON.stringify({ openai: auth }))

    const result = await loadOpenAIAuth(undefined, authFile)

    expect(result).toEqual(auth)
  })

  test.each([
    ["the entry is not OAuth", JSON.stringify({ openai: { type: "api", access: "tok" } })],
    ["access is not a string", JSON.stringify({ openai: { type: "oauth", access: 123 } })],
    ["there is no OpenAI entry", JSON.stringify({ anthropic: { type: "oauth", access: "tok" } })],
    ["the content is malformed JSON", "{not json"],
  ])("returns undefined when %s", async (_condition, content) => {
    const result = await loadOpenAIAuth(content, authFile)

    expect(result).toBeUndefined()
  })

  test("returns undefined when auth.json is missing", async () => {
    const result = await loadOpenAIAuth(undefined, authFile)

    expect(result).toBeUndefined()
  })
})
