import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { buildSavedMessage, pickNonOverwritePath, saveGeneratedImage } from "../../src/output-image"
import { PNG_BASE64, PNG_BUFFER } from "./fixtures"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "out-image-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

// Place a real PNG at the path so it is occupied; pickNonOverwritePath only checks existence.
function occupy(p: string): Promise<void> {
  return writeFile(p, PNG_BUFFER)
}

describe("pickNonOverwritePath", () => {
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
  test("omits the version note when the path was not changed", () => {
    const p = "/tmp/image.png"
    expect(buildSavedMessage(p, p)).toBe(`Generated image saved to ${p}.`)
  })

  test("explains the versioning and forbids relocation when the saved path differs from the requested one", () => {
    const saved = "/tmp/image-v2.png"
    const requested = "/tmp/image.png"
    expect(buildSavedMessage(saved, requested)).toBe(
      `Generated image saved to ${saved}. The requested path ${requested} already existed, ` +
        "so the image was saved under a versioned name to prevent data loss. " +
        "Do not move or rename it to the requested path unless the user explicitly approves; " +
        "report the saved path as-is.",
    )
  })
})

describe("saveGeneratedImage", () => {
  test("writes the decoded image to the requested path", async () => {
    const out = "image.png"
    const result = await saveGeneratedImage(out, dir, PNG_BASE64)
    expect(result.savedPath).toBe(path.join(dir, "image.png"))
    expect(result.versioned).toBe(false)
    const written = await readFile(result.savedPath)
    expect(written.equals(PNG_BUFFER)).toBe(true)
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

  test("versions the output instead of overwriting an existing file", async () => {
    const first = await saveGeneratedImage("image.png", dir, PNG_BASE64)
    const second = await saveGeneratedImage("image.png", dir, PNG_BASE64)
    expect(second.savedPath).toBe(path.join(dir, "image-v2.png"))
    expect(second.versioned).toBe(true)
    // The full message wording is pinned by the buildSavedMessage cases above.
    expect(second.message).toContain(second.savedPath)
    expect(second.message).toContain(first.savedPath)
    // The original file is left untouched.
    expect(existsSync(first.savedPath)).toBe(true)
  })
})
