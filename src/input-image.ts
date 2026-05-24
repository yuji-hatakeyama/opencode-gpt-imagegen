import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileTypeFromBuffer } from "file-type"

async function readImageAsDataUrl(filePath: string, ctxDir: string): Promise<string> {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(ctxDir, filePath)
  const buf = await fs.readFile(abs)
  const detected = await fileTypeFromBuffer(buf)
  if (!detected?.mime.startsWith("image/")) {
    throw new Error(`unsupported image file type: ${abs}`)
  }
  return `data:${detected.mime};base64,${buf.toString("base64")}`
}

// Read the optional reference image paths and encode them as data URLs the Codex
// backend accepts as input_image content. Paths resolve relative to the OpenCode
// context directory unless absolute.
export async function readReferenceImages(paths: string[] | undefined, ctxDir: string): Promise<string[]> {
  return Promise.all((paths ?? []).map((p) => readImageAsDataUrl(p, ctxDir)))
}
