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

export function buildSavedMessage(savedPath: string, requestedPath: string): string {
  // The copy-don't-move instruction is codex's output hint. Without it, agentic callers
  // "fix" the path deviation with mv/rm, defeating the non-overwrite guarantee.
  // https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/ext/image-generation/src/artifact.rs#L38-L48
  const versionNote =
    savedPath !== requestedPath
      ? ` The requested path ${requestedPath} already existed, so the image was saved under a versioned name` +
        " to prevent data loss. If you need the image at another path, copy it and leave the original in place" +
        " unless the user explicitly asks you to move or delete it."
      : ""
  return `Generated image saved to ${savedPath}.${versionNote}`
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
  await fs.writeFile(savedPath, Buffer.from(base64, "base64"))
  return {
    savedPath,
    versioned: savedPath !== requestedPath,
    message: buildSavedMessage(savedPath, requestedPath),
  }
}
