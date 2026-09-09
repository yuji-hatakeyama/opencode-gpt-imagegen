import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileTypeFromBuffer } from "file-type"

async function readImageAsDataUrl(filePath: string, ctxDir: string): Promise<string> {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(ctxDir, filePath)
  // Failure wording mirrors codex's referenced-image errors. Unlike codex, the MIME type
  // comes from magic-byte sniffing and no format is re-encoded (ADR 0001 #10).
  // https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/ext/image-generation/src/tool.rs#L552-L578
  let buf: Buffer
  try {
    buf = await fs.readFile(abs)
  } catch (err) {
    throw new Error(`unable to read referenced image at \`${abs}\`: ${err instanceof Error ? err.message : err}`)
  }
  const detected = await fileTypeFromBuffer(buf)
  if (!detected?.mime.startsWith("image/")) {
    throw new Error(`unable to process referenced image at \`${abs}\`: unsupported image file type`)
  }
  return `data:${detected.mime};base64,${buf.toString("base64")}`
}

// Read the optional reference image paths and encode them as data URLs the Codex
// backend accepts as image_url content. Paths resolve relative to the OpenCode context
// directory unless absolute. The count is capped by the tool schema in index.ts.
export async function readReferenceImages(paths: string[] | undefined, ctxDir: string): Promise<string[]> {
  return Promise.all((paths ?? []).map((p) => readImageAsDataUrl(p, ctxDir)))
}
