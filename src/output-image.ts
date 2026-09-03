import * as fs from "node:fs/promises"
import * as path from "node:path"

const MAX_OUTPUT_VERSION_SUFFIX = 999

function versionedPath(requested: string, version: number): string {
  if (version === 1) return requested
  const dir = path.dirname(requested)
  const ext = path.extname(requested)
  const stem = path.basename(requested, ext)
  return path.join(dir, `${stem}-v${version}${ext}`)
}

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
  for (let n = 2; n <= maxVersion; n++) {
    const candidate = versionedPath(requested, n)
    if (!(await pathExists(candidate))) return candidate
  }
  const dir = path.dirname(requested)
  const ext = path.extname(requested)
  const stem = path.basename(requested, ext)
  throw new Error(
    `could not find a non-conflicting filename under ${dir}/${stem}-vN${ext} (tried up to v${maxVersion})`,
  )
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST"
}

async function writeImageWithoutOverwrite(requested: string, image: Buffer): Promise<string> {
  for (let n = 1; n <= MAX_OUTPUT_VERSION_SUFFIX; n++) {
    const candidate = versionedPath(requested, n)
    try {
      await fs.writeFile(candidate, image, { flag: "wx", mode: 0o600 })
      return candidate
    } catch (error) {
      if (isAlreadyExists(error)) continue
      throw error
    }
  }

  const dir = path.dirname(requested)
  const ext = path.extname(requested)
  const stem = path.basename(requested, ext)
  throw new Error(
    `could not find a non-conflicting filename under ${dir}/${stem}-vN${ext} (tried up to v${MAX_OUTPUT_VERSION_SUFFIX})`,
  )
}

export function buildSavedMessage(savedPath: string, requestedPath: string): string {
  const versionNote =
    savedPath !== requestedPath
      ? ` (the requested path ${requestedPath} already existed; the new image was versioned to avoid overwriting it)`
      : ""
  return `Generated image saved to ${savedPath}${versionNote}.`
}

type SaveResult = { savedPath: string; versioned: boolean; message: string }

// Resolve the output path (relative to ctxDir unless absolute), then atomically
// create the decoded PNG. Existing files are never overwritten, even when
// concurrent generations request the same output path.
export async function saveGeneratedImage(out: string, ctxDir: string, base64: string): Promise<SaveResult> {
  const requestedPath = path.isAbsolute(out) ? out : path.resolve(ctxDir, out)
  await fs.mkdir(path.dirname(requestedPath), { recursive: true })
  const savedPath = await writeImageWithoutOverwrite(requestedPath, Buffer.from(base64, "base64"))
  return {
    savedPath,
    versioned: savedPath !== requestedPath,
    message: buildSavedMessage(savedPath, requestedPath),
  }
}
