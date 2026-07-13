import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { readReferenceImages, resolveReferenceImages } from "../../src/input-image"
import { pngDataUrl as dataUrl, PNG_BUFFER as PNG } from "./fixtures"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "input-image-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("readReferenceImages", () => {
  test("returns an empty array when given an empty list", async () => {
    expect(await readReferenceImages([], dir)).toEqual([])
  })

  test("encodes a PNG as a base64 data URL with the detected MIME type", async () => {
    await writeFile(path.join(dir, "ref.png"), PNG)
    expect(await readReferenceImages(["ref.png"], dir)).toEqual([dataUrl(PNG)])
  })

  // The MIME type comes from file-type's content sniffing, not the extension; one
  // non-PNG format is enough to prove the detected type (not a hard-coded "image/png") is used.
  test("detects a JPEG file and uses its MIME type in the data URL", async () => {
    const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
    await writeFile(path.join(dir, "ref-jpeg"), bytes)
    expect(await readReferenceImages(["ref-jpeg"], dir)).toEqual([`data:image/jpeg;base64,${bytes.toString("base64")}`])
  })

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
    await expect(readReferenceImages(["notes.txt"], dir)).rejects.toThrow(
      `unable to process referenced image at \`${abs}\`: unsupported image file type`,
    )
  })

  // Promise.all means one bad path fails the whole call — the opposite of auth.ts, which
  // deliberately swallows read errors. Pin that contract so a future change can't silently drop a missing reference.
  test("rejects the whole call when any path is missing", async () => {
    await writeFile(path.join(dir, "present.png"), PNG)
    await expect(readReferenceImages(["present.png", "missing.png"], dir)).rejects.toThrow(
      `unable to read referenced image at \`${path.join(dir, "missing.png")}\``,
    )
  })
})

describe("resolveReferenceImages", () => {
  const recent = ["data:image/png;base64,ONE", "data:image/png;base64,TWO", "data:image/png;base64,THREE"]

  test("returns an empty array when neither selector is given", async () => {
    expect(await resolveReferenceImages({}, dir, recent)).toEqual([])
  })

  test("reads referenced_image_paths as data URLs", async () => {
    await writeFile(path.join(dir, "ref.png"), PNG)
    const args = { referenced_image_paths: ["ref.png"] }
    expect(await resolveReferenceImages(args, dir, recent)).toEqual([dataUrl(PNG)])
  })

  test("accepts exactly 5 referenced_image_paths", async () => {
    await writeFile(path.join(dir, "ref.png"), PNG)
    const args = { referenced_image_paths: Array.from({ length: 5 }, () => "ref.png") }
    expect(await resolveReferenceImages(args, dir, recent)).toEqual(Array.from({ length: 5 }, () => dataUrl(PNG)))
  })

  test("returns all 5 session images when num_last_images_to_include is 5 and 5 are available", async () => {
    const five = ["u1", "u2", "u3", "u4", "u5"]
    expect(await resolveReferenceImages({ num_last_images_to_include: 5 }, dir, five)).toEqual(five)
  })

  test("returns the last N session images when num_last_images_to_include is given", async () => {
    const args = { num_last_images_to_include: 2 }
    expect(await resolveReferenceImages(args, dir, recent)).toEqual([
      "data:image/png;base64,TWO",
      "data:image/png;base64,THREE",
    ])
  })

  test("throws when more than 5 paths are given", async () => {
    const args = { referenced_image_paths: Array.from({ length: 6 }, () => "ref.png") }
    await expect(resolveReferenceImages(args, dir, recent)).rejects.toThrow(
      "`referenced_image_paths` must contain at most 5 paths",
    )
  })

  test("throws when both selectors are given", async () => {
    const args = { referenced_image_paths: ["ref.png"], num_last_images_to_include: 1 }
    await expect(resolveReferenceImages(args, dir, recent)).rejects.toThrow(
      "provide only one of `referenced_image_paths` or `num_last_images_to_include`",
    )
  })

  test("throws when num_last_images_to_include is below 1", async () => {
    await expect(resolveReferenceImages({ num_last_images_to_include: 0 }, dir, recent)).rejects.toThrow(
      "`num_last_images_to_include` must be between 1 and 5",
    )
  })

  test("throws when num_last_images_to_include is above 5", async () => {
    await expect(resolveReferenceImages({ num_last_images_to_include: 6 }, dir, recent)).rejects.toThrow(
      "`num_last_images_to_include` must be between 1 and 5",
    )
  })

  test("throws when fewer session images are available than requested", async () => {
    await expect(resolveReferenceImages({ num_last_images_to_include: 2 }, dir, ["only-one"])).rejects.toThrow(
      "requested the last 2 images generated in this session, but only 1 were available",
    )
  })
})
