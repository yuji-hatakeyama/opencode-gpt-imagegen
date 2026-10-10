import { describe, expect, test } from "bun:test"
import { appendSizeToPrompt, parseImageSize } from "../../src/size"

describe("appendSizeToPrompt", () => {
  test("appends the width, height, and aspect ratio of the size", () => {
    const prompt = "a mountain lake"

    const result = appendSizeToPrompt(prompt, "1672x941")

    expect(result).toBe(
      `${prompt} Generate the image with a width of 1672 pixels and a height of 941 pixels (16:9 aspect ratio).`,
    )
  })

  test("returns the prompt unchanged when no size is given", () => {
    const prompt = "a mountain lake"

    const result = appendSizeToPrompt(prompt, undefined)

    expect(result).toBe(prompt)
  })
})

describe("parseImageSize", () => {
  test("returns a supported size as is", () => {
    const result = parseImageSize("1672x941")

    expect(result).toBe("1672x941")
  })

  test("returns undefined when no size is given", () => {
    const result = parseImageSize(undefined)

    expect(result).toBeUndefined()
  })

  test("throws an error listing the supported sizes when the size is not supported", () => {
    const act = () => parseImageSize("1280x720")

    expect(act).toThrow(
      'Unsupported size "1280x720". Use one of: 1254x1254 (1:1), 1536x1024 (3:2), 1024x1536 (2:3), ' +
        "1448x1086 (4:3), 1086x1448 (3:4), 1672x941 (16:9), 941x1672 (9:16).",
    )
  })
})
