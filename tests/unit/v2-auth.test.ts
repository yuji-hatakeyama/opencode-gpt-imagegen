import { describe, expect, mock, test } from "bun:test"
import { loadOpenAIAuth } from "../../src/v2-auth"

type Connection = Parameters<typeof loadOpenAIAuth>[0]
type CredentialConnection = Extract<NonNullable<Awaited<ReturnType<Connection["active"]>>>, { type: "credential" }>
type Credential = NonNullable<Awaited<ReturnType<Connection["resolve"]>>>

function createConnection(overrides: Partial<CredentialConnection> = {}): CredentialConnection {
  return { type: "credential", id: "cred_codex", label: "Codex", method: "oauth", ...overrides }
}

describe("loadOpenAIAuth", () => {
  test.each(["chatgpt-browser", "chatgpt-headless"])(
    "resolves %s credentials for the active OpenAI connection (#136)",
    async (methodID) => {
      const connection = createConnection()
      const access = "codex-token"
      const accountID = "chatgpt-account"
      const active = mock<Connection["active"]>(async () => connection)
      const resolve = mock<Connection["resolve"]>(async () => ({
        type: "oauth",
        methodID: methodID as Extract<Credential, { type: "oauth" }>["methodID"],
        access,
        refresh: "refresh-token",
        expires: 0,
        metadata: { accountID },
      }))

      const result = await loadOpenAIAuth({ active, resolve })

      expect(result).toEqual({ type: "oauth", access, accountId: accountID })
      expect(active.mock.calls).toEqual([["openai"]])
      expect(resolve.mock.calls).toEqual([[connection]])
    },
  )

  test("returns undefined without resolving credentials when there is no active connection (#136)", async () => {
    const active = mock<Connection["active"]>(async () => undefined)
    const resolve = mock<Connection["resolve"]>(async () => undefined)

    const result = await loadOpenAIAuth({ active, resolve })

    expect(result).toBeUndefined()
    expect(active.mock.calls).toEqual([["openai"]])
    expect(resolve).not.toHaveBeenCalled()
  })

  test("returns undefined when the active connection has no resolved credential (#136)", async () => {
    const connection = createConnection({ id: "cred_missing" })
    const active = mock<Connection["active"]>(async () => connection)
    const resolve = mock<Connection["resolve"]>(async () => undefined)

    const result = await loadOpenAIAuth({ active, resolve })

    expect(result).toBeUndefined()
    expect(resolve.mock.calls).toEqual([[connection]])
  })

  test("rejects API key credentials with Codex sign-in instructions (#136)", async () => {
    const connection = createConnection({ id: "cred_key", method: "key" })
    const credential: Credential = { type: "key", key: "api-key" }

    const result = loadOpenAIAuth({ active: async () => connection, resolve: async () => credential })

    await expect(result).rejects.toThrow(
      'The OpenAI connection\'s sign-in method (key) cannot generate images. In OpenCode, connect OpenAI and choose "Codex browser (legacy)" or "Codex device code (legacy)".',
    )
  })

  test("retains the host credential resolution error instead of reporting missing auth (#136)", async () => {
    const error = new Error("OAuth refresh failed: credential revoked")
    const connection = createConnection({ id: "cred_revoked" })

    const result = loadOpenAIAuth({
      active: async () => connection,
      resolve: async () => {
        throw error
      },
    })

    await expect(result).rejects.toBe(error)
  })

  test("rejects token-sharing with Codex sign-in instructions (#136)", async () => {
    const connection = createConnection({ id: "cred_sharing" })
    const credential: Credential = {
      type: "oauth",
      methodID: "chatgpt-token-sharing" as Extract<Credential, { type: "oauth" }>["methodID"],
      access: "sharing-token",
      refresh: "refresh-token",
      expires: 0,
    }

    const result = loadOpenAIAuth({ active: async () => connection, resolve: async () => credential })

    await expect(result).rejects.toThrow(
      'The OpenAI connection\'s sign-in method (chatgpt-token-sharing) cannot generate images. In OpenCode, connect OpenAI and choose "Codex browser (legacy)" or "Codex device code (legacy)".',
    )
  })
})
