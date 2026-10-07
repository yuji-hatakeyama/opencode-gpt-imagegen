import { describe, expect, mock, test } from "bun:test"
import type { Credential } from "@opencode/plugin"
import { loadOpenAIAuthFromConnection } from "../../src/auth"

const ACTIVE = { type: "credential", id: "cred-codex", label: "Codex", method: "oauth" } as const
type ConnectionAPI = Parameters<typeof loadOpenAIAuthFromConnection>[0]
type ActiveConnection = Parameters<ConnectionAPI["resolve"]>[0]

function oauth(method = "chatgpt-browser", metadata?: Record<string, unknown>): Credential.OAuth {
  return {
    type: "oauth",
    methodID: method as Credential.OAuth["methodID"],
    access: "resolved-access-token",
    refresh: "refresh-token",
    expires: Date.now() + 60_000,
    metadata,
  }
}

function connection(credential: Credential.Value | undefined) {
  return {
    active: mock(async (_integrationID: string) => ACTIVE),
    resolve: mock(async (_active: ActiveConnection) => credential),
  }
}

describe("loadOpenAIAuthFromConnection (V2)", () => {
  test("resolves the active OpenAI connection and reads the Codex accountID metadata", async () => {
    const api = connection(oauth("chatgpt-browser", { accountID: "acct-v2" }))
    expect(await loadOpenAIAuthFromConnection(api)).toEqual({
      type: "oauth",
      access: "resolved-access-token",
      accountId: "acct-v2",
    })
    expect(api.active).toHaveBeenCalledWith("openai")
    expect(api.resolve).toHaveBeenCalledWith(ACTIVE)
  })

  test("supports the Codex device-code connection", async () => {
    expect(await loadOpenAIAuthFromConnection(connection(oauth("chatgpt-headless")))).toEqual({
      type: "oauth",
      access: "resolved-access-token",
    })
  })

  test("does not resolve or fall back to auth.json when there is no active connection", async () => {
    const api = { ...connection(oauth()), active: mock(async () => undefined) }
    expect(await loadOpenAIAuthFromConnection(api)).toBeUndefined()
    expect(api.resolve).not.toHaveBeenCalled()
  })

  test("returns undefined when the active credential cannot be resolved", async () => {
    expect(await loadOpenAIAuthFromConnection(connection(undefined))).toBeUndefined()
  })

  test("does not treat API keys as subscription credentials", async () => {
    expect(await loadOpenAIAuthFromConnection(connection({ type: "key", key: "api-key" }))).toBeUndefined()
  })

  test("explains how to replace a token-sharing connection", async () => {
    await expect(loadOpenAIAuthFromConnection(connection(oauth("chatgpt-token-sharing")))).rejects.toThrow(
      "Connect OpenAI using Codex browser (legacy) or Codex device code (legacy)",
    )
  })

  test("does not use unrelated OAuth methods for the Codex backend", async () => {
    expect(await loadOpenAIAuthFromConnection(connection(oauth("custom-oauth")))).toBeUndefined()
  })

  test("ignores accountID metadata that is not a string", async () => {
    expect(await loadOpenAIAuthFromConnection(connection(oauth("chatgpt-browser", { accountID: 123 })))).toEqual({
      type: "oauth",
      access: "resolved-access-token",
    })
  })

  test("preserves errors reported by credential resolution", async () => {
    const api = {
      ...connection(undefined),
      resolve: mock(async () => {
        throw new Error("sign in again")
      }),
    }
    await expect(loadOpenAIAuthFromConnection(api)).rejects.toThrow("sign in again")
  })
})
