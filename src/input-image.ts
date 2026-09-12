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

function resolveRemoteReference(reference: string): string | undefined {
  if (reference.startsWith("data:image/")) return reference
  if (/^https?:\/\//i.test(reference)) {
    const url = new URL(reference)
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new Error(`unsupported reference image URL protocol: ${url.protocol}`)
    }
    return reference
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(reference)) {
    throw new Error(`unsupported reference image URL protocol: ${new URL(reference).protocol}`)
  }
  return undefined
}

// Preserve remote URLs and data URIs so the Codex backend can fetch or consume
// them directly. Local paths remain compatible and are encoded as data URLs.
export async function readReferenceImages(references: string[] | undefined, ctxDir: string): Promise<string[]> {
  return Promise.all(
    (references ?? []).map((reference) => resolveRemoteReference(reference) ?? readImageAsDataUrl(reference, ctxDir)),
  )
}
