import { describe, expect, test } from "bun:test"
import plugin from "../../src/index"
import { server } from "../../src/v1"

describe("plugin", () => {
  test("exposes the V1 adapter under the plugin ID (#136)", () => {
    expect(plugin).toEqual({
      id: "opencode-gpt-imagegen",
      server,
    })
  })
})
