import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readReferenceImages } from "../../src/input-image"

// A 1x1 transparent PNG; file-type recognizes it from the header bytes.
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
)

function dataUrl(buf: Buffer): string {
  return `data:image/png;base64,${buf.toString("base64")}`
}

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "input-image-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("readReferenceImages", () => {
  test("returns an empty array when given undefined", async () => {
    expect(await readReferenceImages(undefined, dir)).toEqual([])
  })

  test("returns an empty array when given an empty list", async () => {
    expect(await readReferenceImages([], dir)).toEqual([])
  })

  test("encodes a PNG as a base64 data URL with the detected MIME type", async () => {
    await writeFile(path.join(dir, "ref.png"), PNG)
    expect(await readReferenceImages(["ref.png"], dir)).toEqual([dataUrl(PNG)])
  })

  // The MIME type comes from file-type's content sniffing, not the extension, so cover a
  // few non-PNG formats to confirm the detected type (not a hard-coded "image/png") is used.
  // Each case is a minimal header file-type recognizes from its magic bytes.
  const formats: Array<{ name: string; mime: string; bytes: Buffer }> = [
    { name: "JPEG", mime: "image/jpeg", bytes: Buffer.from([0xff, 0xd8, 0xff, 0xe0]) },
    { name: "GIF", mime: "image/gif", bytes: Buffer.from("GIF89a") },
    {
      name: "WebP",
      mime: "image/webp",
      bytes: Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBP")]),
    },
    { name: "BMP", mime: "image/bmp", bytes: Buffer.concat([Buffer.from("BM"), Buffer.alloc(16)]) },
  ]
  for (const { name, mime, bytes } of formats) {
    test(`detects a ${name} file and uses its MIME type in the data URL`, async () => {
      const file = `ref-${name.toLowerCase()}`
      await writeFile(path.join(dir, file), bytes)
      expect(await readReferenceImages([file], dir)).toEqual([`data:${mime};base64,${bytes.toString("base64")}`])
    })
  }

  test("resolves relative paths against the context directory", async () => {
    await writeFile(path.join(dir, "ref.png"), PNG)
    const abs = path.join(dir, "ref.png")
    const [viaRelative] = await readReferenceImages(["ref.png"], dir)
    const [viaAbsolute] = await readReferenceImages([abs], "/some/other/ctx")
    expect(viaRelative).toBe(viaAbsolute)
  })

  test("preserves the input order across multiple images", async () => {
    // A second PNG with extra trailing bytes: still detected as PNG, but distinct base64.
    const png2 = Buffer.concat([PNG, Buffer.from("trailer")])
    await writeFile(path.join(dir, "first.png"), PNG)
    await writeFile(path.join(dir, "second.png"), png2)
    expect(await readReferenceImages(["first.png", "second.png"], dir)).toEqual([dataUrl(PNG), dataUrl(png2)])
  })

  test("throws when a file is not a recognized image", async () => {
    const abs = path.join(dir, "notes.txt")
    await writeFile(abs, "this is plain text, not an image")
    expect(readReferenceImages(["notes.txt"], dir)).rejects.toThrow(`unsupported image file type: ${abs}`)
  })

  // Promise.all means one bad path fails the whole call — the opposite of auth.ts, which
  // deliberately swallows read errors. Pin that contract so a future change can't silently drop a missing reference.
  test("rejects the whole call when any path is missing", async () => {
    await writeFile(path.join(dir, "present.png"), PNG)
    expect(readReferenceImages(["present.png", "missing.png"], dir)).rejects.toThrow()
  })
})
