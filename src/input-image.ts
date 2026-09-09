import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileTypeFromBuffer } from "file-type"
import { MAX_EDIT_IMAGES } from "./codex"

async function readImageAsDataUrl(filePath: string, ctxDir: string): Promise<string> {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(ctxDir, filePath)
  // Failure wording mirrors codex's referenced-image errors. Unlike codex, the MIME type
  // comes from magic-byte sniffing and no format is re-encoded (codex converts anything
  // but PNG/JPEG/WebP to PNG); a raster re-encoder is too heavy a dependency for a plugin.
  // https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/ext/image-generation/src/tool.rs#L552-L578
  // https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/utils/image/src/lib.rs#L354-L361
  let buf: Buffer
  try {
    buf = await fs.readFile(abs)
  } catch (err) {
    throw new Error(`unable to read referenced image at \`${abs}\`: ${err}`)
  }
  const detected = await fileTypeFromBuffer(buf)
  if (!detected?.mime.startsWith("image/")) {
    throw new Error(`unable to process referenced image at \`${abs}\`: unsupported image file type`)
  }
  return `data:${detected.mime};base64,${buf.toString("base64")}`
}

// Read the optional reference image paths and encode them as data URLs the Codex
// backend accepts as image_url content. Paths resolve relative to the OpenCode context
// directory unless absolute. The cap and its wording mirror codex's request_for_call_args
// (with this plugin's argument name); the schema in index.ts enforces the same bound,
// and the runtime re-check is kept because codex has both layers too.
// https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/ext/image-generation/src/tool.rs#L424-L429
export async function readReferenceImages(paths: string[] | undefined, ctxDir: string): Promise<string[]> {
  const list = paths ?? []
  if (list.length > MAX_EDIT_IMAGES) {
    throw new Error(`\`images\` must contain at most ${MAX_EDIT_IMAGES} paths`)
  }
  return Promise.all(list.map((p) => readImageAsDataUrl(p, ctxDir)))
}
