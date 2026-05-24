import * as fs from "node:fs/promises"
import * as path from "node:path"
import { fileTypeFromBuffer } from "file-type"

export async function readImageAsDataUrl(filePath: string, ctxDir: string): Promise<string> {
  const abs = path.isAbsolute(filePath) ? filePath : path.resolve(ctxDir, filePath)
  const buf = await fs.readFile(abs)
  const detected = await fileTypeFromBuffer(buf)
  if (!detected?.mime.startsWith("image/")) {
    throw new Error(`unsupported image file type: ${abs}`)
  }
  return `data:${detected.mime};base64,${buf.toString("base64")}`
}
