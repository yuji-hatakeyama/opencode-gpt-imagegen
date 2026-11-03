import { describe, expect, test } from "bun:test"
import plugin from "../../src/index"
import { server } from "../../src/v1"
import { setup } from "../../src/v2"

describe("plugin", () => {
  test("exposes the V1 and V2 adapters under the plugin ID (#136)", () => {
    expect(plugin).toEqual({
      id: "opencode-gpt-imagegen",
      server,
      setup,
    })
  })
})
