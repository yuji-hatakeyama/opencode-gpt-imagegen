import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test"
import { existsSync } from "node:fs"
import * as fs from "node:fs/promises"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildSavedMessage, pickNonOverwritePath, saveGeneratedImage } from "../../src/output-image"
import { PNG_BASE64, PNG_BUFFER } from "./fixtures"

let dir: string

function useTempDirectory(): void {
  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "out-image-"))
  })

  afterEach(async () => {
    mock.restore()
    await rm(dir, { recursive: true, force: true })
  })
}

// Place a real PNG at the path so it is occupied; pickNonOverwritePath only checks existence.
function occupy(p: string): Promise<void> {
  return writeFile(p, PNG_BUFFER)
}

describe("pickNonOverwritePath", () => {
  useTempDirectory()

  test("returns the requested path when nothing exists", async () => {
    const requested = path.join(dir, "image.png")
    expect(await pickNonOverwritePath(requested)).toBe(requested)
  })

  test("appends -v2 when the requested path exists", async () => {
    const requested = path.join(dir, "image.png")
    await occupy(requested)
    expect(await pickNonOverwritePath(requested)).toBe(path.join(dir, "image-v2.png"))
  })

  test("skips to the first free suffix when earlier versions exist", async () => {
    const requested = path.join(dir, "image.png")
    await occupy(requested)
    await occupy(path.join(dir, "image-v2.png"))
    expect(await pickNonOverwritePath(requested)).toBe(path.join(dir, "image-v3.png"))
  })

  test("preserves the extension and stem in the versioned name", async () => {
    const requested = path.join(dir, "my.photo.jpeg")
    await occupy(requested)
    expect(await pickNonOverwritePath(requested)).toBe(path.join(dir, "my.photo-v2.jpeg"))
  })

  test("throws once every version up to the limit is taken", async () => {
    // maxVersion is lowered to 2 so we can fill the suffix space without writing 999 files.
    const requested = path.join(dir, "image.png")
    await occupy(requested)
    await occupy(path.join(dir, "image-v2.png"))
    expect(pickNonOverwritePath(requested, 2)).rejects.toThrow(
      `could not find a non-conflicting filename under ${dir}/image-vN.png (tried up to v2)`,
    )
  })
})

describe("buildSavedMessage", () => {
  const size = { width: 1672, height: 941 }

  test("reports the path and pixel size without a version note when the path was not changed", () => {
    const p = "/tmp/image.png"
    expect(buildSavedMessage(p, p, size)).toBe(`Generated image saved to ${p}. The image is 1672x941 pixels.`)
  })

  test("explains versioning and reports the backend details (#166)", () => {
    const saved = "/tmp/image-v2.png"
    const requested = "/tmp/image.png"

    const message = buildSavedMessage(saved, requested, size, { quality: "low", outputTokens: 515 })

    expect(message).toBe(
      `Generated image saved to ${saved} (the requested path ${requested} already existed; ` +
        "the new image was versioned to avoid overwriting it). The image is 1672x941 pixels (quality: low, output_tokens: 515).",
    )
  })

  test.each([
    {
      name: "quality before output tokens",
      details: { quality: "low", outputTokens: 515 },
      expected: "The image is 1672x941 pixels (quality: low, output_tokens: 515).",
    },
    {
      name: "quality alone",
      details: { quality: "medium" },
      expected: "The image is 1672x941 pixels (quality: medium).",
    },
    {
      name: "output tokens alone",
      details: { outputTokens: 515 },
      expected: "The image is 1672x941 pixels (output_tokens: 515).",
    },
    {
      name: "zero output tokens when quality is empty",
      details: { quality: "", outputTokens: 0 },
      expected: "The image is 1672x941 pixels (output_tokens: 0).",
    },
    { name: "no details", details: {}, expected: "The image is 1672x941 pixels." },
  ])("reports $name in the saved message (#166)", ({ details, expected }) => {
    const saved = "/tmp/image.png"

    const message = buildSavedMessage(saved, saved, size, details)

    expect(message).toBe(`Generated image saved to ${saved}. ${expected}`)
  })
})

describe("saveGeneratedImage", () => {
  useTempDirectory()

  test("writes the decoded image to the requested path", async () => {
    const out = "image.png"
    const result = await saveGeneratedImage(out, dir, PNG_BASE64)
    expect(result.savedPath).toBe(path.join(dir, "image.png"))
    expect(result.versioned).toBe(false)
    const written = await readFile(result.savedPath)
    expect(written.equals(PNG_BUFFER)).toBe(true)
  })

  test("reports the pixel size read from the PNG in the message", async () => {
    // PNG_BASE64 is a 1x1 image.
    const result = await saveGeneratedImage("image.png", dir, PNG_BASE64)
    expect(result.message).toBe(`Generated image saved to ${result.savedPath}. The image is 1x1 pixels.`)
  })

  test("resolves a relative path against the context directory", async () => {
    const result = await saveGeneratedImage("nested/image.png", dir, PNG_BASE64)
    expect(result.savedPath).toBe(path.join(dir, "nested", "image.png"))
    expect(existsSync(result.savedPath)).toBe(true)
  })

  test("honors an absolute output path verbatim", async () => {
    const abs = path.join(dir, "absolute.png")
    const result = await saveGeneratedImage(abs, "/some/other/ctx", PNG_BASE64)
    expect(result.savedPath).toBe(abs)
  })

  test("creates missing parent directories", async () => {
    const result = await saveGeneratedImage("a/b/c/image.png", dir, PNG_BASE64)
    expect(existsSync(result.savedPath)).toBe(true)
  })

  test("versions the output instead of overwriting an existing file", async () => {
    const first = await saveGeneratedImage("image.png", dir, PNG_BASE64)
    const second = await saveGeneratedImage("image.png", dir, PNG_BASE64)
    expect(second.savedPath).toBe(path.join(dir, "image-v2.png"))
    expect(second.versioned).toBe(true)
    expect(second.message).toBe(
      `Generated image saved to ${second.savedPath} (the requested path ${first.savedPath} already existed; ` +
        "the new image was versioned to avoid overwriting it). The image is 1x1 pixels.",
    )
    // The original file is left untouched.
    expect(existsSync(first.savedPath)).toBe(true)
  })

  test("saves into an existing directory even when mkdir rejects it with EEXIST (#121)", async () => {
    // Bun on Windows before 1.4.0 throws EEXIST for an existing ReadOnly directory such as Desktop.
    const eexist = Object.assign(new Error("EEXIST: file already exists, mkdir"), { code: "EEXIST" })
    const mkdirSpy = spyOn(fs, "mkdir").mockRejectedValueOnce(eexist)
    const result = await saveGeneratedImage("image.png", dir, PNG_BASE64)
    expect(mkdirSpy).toHaveBeenCalledWith(dir, expect.anything())
    expect(result.savedPath).toBe(path.join(dir, "image.png"))
    const written = await readFile(result.savedPath)
    expect(written.equals(PNG_BUFFER)).toBe(true)
  })

  test("rejects with EEXIST when a file occupies the output directory path", async () => {
    await occupy(path.join(dir, "occupied"))
    await expect(saveGeneratedImage("occupied/image.png", dir, PNG_BASE64)).rejects.toMatchObject({ code: "EEXIST" })
  })
})
