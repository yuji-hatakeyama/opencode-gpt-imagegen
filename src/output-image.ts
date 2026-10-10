import * as fs from "node:fs/promises"
import * as path from "node:path"

const MAX_OUTPUT_VERSION_SUFFIX = 999

async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.access(p)
    return true
  } catch {
    return false
  }
}

// maxVersion is injectable only so tests can reach the exhaustion branch cheaply; production callers use the default.
export async function pickNonOverwritePath(requested: string, maxVersion = MAX_OUTPUT_VERSION_SUFFIX): Promise<string> {
  if (!(await pathExists(requested))) return requested
  const dir = path.dirname(requested)
  const ext = path.extname(requested)
  const stem = path.basename(requested, ext)
  for (let n = 2; n <= maxVersion; n++) {
    const candidate = path.join(dir, `${stem}-v${n}${ext}`)
    if (!(await pathExists(candidate))) return candidate
  }
  throw new Error(
    `could not find a non-conflicting filename under ${dir}/${stem}-vN${ext} (tried up to v${maxVersion})`,
  )
}

type PixelSize = { width: number; height: number }

// The width and height sit at fixed offsets in the IHDR chunk, which always follows the 8-byte PNG signature.
function readPngSize(png: Buffer): PixelSize {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

// The pixel size is reported because the backend can return an edge 1px off from the requested size.
export function buildSavedMessage(savedPath: string, requestedPath: string, size: PixelSize): string {
  const versionNote =
    savedPath !== requestedPath
      ? ` (the requested path ${requestedPath} already existed; the new image was versioned to avoid overwriting it)`
      : ""
  return `Generated image saved to ${savedPath}${versionNote}. The image is ${size.width}x${size.height} pixels.`
}

type SaveResult = { savedPath: string; versioned: boolean; message: string }

// Resolve the output path (relative to ctxDir unless absolute), then write the
// decoded PNG. Avoiding an overwrite is best-effort: the collision check and the
// write are not atomic, so a concurrent writer racing between them could still be
// clobbered. Returns the user-facing message alongside the saved path.
export async function saveGeneratedImage(out: string, ctxDir: string, base64: string): Promise<SaveResult> {
  const requestedPath = path.isAbsolute(out) ? out : path.resolve(ctxDir, out)
  await fs.mkdir(path.dirname(requestedPath), { recursive: true })
  const savedPath = await pickNonOverwritePath(requestedPath)
  const png = Buffer.from(base64, "base64")
  await fs.writeFile(savedPath, png)
  return {
    savedPath,
    versioned: savedPath !== requestedPath,
    message: buildSavedMessage(savedPath, requestedPath, readPngSize(png)),
  }
}
