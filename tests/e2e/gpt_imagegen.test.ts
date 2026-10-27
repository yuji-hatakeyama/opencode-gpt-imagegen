import { beforeAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const WORKDIR = await mkdtemp(path.join(os.tmpdir(), "qa-imagegen-work-"))
const XDG_CONFIG_HOME = await mkdtemp(path.join(os.tmpdir(), "qa-imagegen-cfg-"))
const REPO_DIR = path.resolve(import.meta.dir, "../..")
const RUN_TIMEOUT_MS = 600_000
const TEST_TIMEOUT_MS = RUN_TIMEOUT_MS + 10_000
const STYLE = "hand-drawn 90s Japanese animation style"

async function runCommand(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: REPO_DIR,
      stdio: "inherit",
    })
    proc.on("error", reject)
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`${command} ${args.join(" ")} failed (exit=${code})`))
      else resolve()
    })
  })
}

async function writeOpencodeConfig(): Promise<void> {
  const cfgDir = path.join(XDG_CONFIG_HOME, "opencode")
  await mkdir(cfgDir, { recursive: true })
  const config = {
    $schema: "https://opencode.ai/config.json",
    // OpenCode 2.1.1 resolves local directories by their root index, not package.json exports.
    plugins: [pathToFileURL(path.join(REPO_DIR, "dist")).href],
    // Denying execute also removes Code Mode's filesystem/session utilities.
    permissions: [
      { action: "*", resource: "*", effect: "deny" },
      { action: "gpt_imagegen", resource: "*", effect: "allow" },
    ],
  }
  await writeFile(path.join(cfgDir, "opencode.jsonc"), JSON.stringify(config, null, 2))
}

async function runOpencode(prompt: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["run", "--standalone", prompt]
    if (process.env.OPENCODE_MODEL) args.push("--model", process.env.OPENCODE_MODEL)
    const proc = spawn("opencode", args, {
      cwd: WORKDIR,
      // OpenCode waits for EOF on piped stdin before sending the prompt.
      stdio: ["ignore", "inherit", "inherit"],
      // Isolate configuration in the private server while retaining the credential data directory.
      env: {
        ...process.env,
        // V2 run prefers PWD over the process working directory.
        PWD: WORKDIR,
        XDG_CONFIG_HOME,
        OPENCODE_CONFIG_DIR: path.join(XDG_CONFIG_HOME, "opencode"),
        OPENCODE_CONFIG: undefined,
        OPENCODE_CONFIG_CONTENT: undefined,
        OPENCODE_CONFIG_PROJECT_DISABLE: undefined,
        OPENCODE_DISABLE_PROJECT_CONFIG: "1",
      },
    })
    const timer = setTimeout(() => {
      proc.kill("SIGTERM")
    }, RUN_TIMEOUT_MS)
    proc.on("error", (err) => {
      clearTimeout(timer)
      reject(err)
    })
    proc.on("close", (code, signal) => {
      clearTimeout(timer)
      if (signal === "SIGTERM") {
        reject(new Error(`opencode run timed out after ${RUN_TIMEOUT_MS}ms`))
        return
      }
      if (code !== 0) {
        reject(new Error(`opencode run failed (exit=${code} signal=${signal ?? "null"})`))
        return
      }
      resolve()
    })
  })
}

async function assertPng(filePath: string): Promise<Buffer> {
  expect(existsSync(filePath)).toBe(true)
  const buf = await readFile(filePath)
  expect(buf.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a")
  return buf
}

function readPngDimensions(buf: Buffer): { width: number; height: number } {
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

// The color type sits in the IHDR chunk right after the bit depth. 6 means RGBA.
function readPngColorType(buf: Buffer): number {
  return buf[25]
}

describe("gpt_imagegen e2e", () => {
  beforeAll(async () => {
    await runCommand("opencode", ["--version"])
    console.log(`WORKDIR: ${WORKDIR}`)
    console.log(`XDG_CONFIG_HOME: ${XDG_CONFIG_HOME}`)
    await runCommand("bun", ["run", "build"])
    await writeOpencodeConfig()
  })

  test(
    "A. man portrait 1024x1536",
    async () => {
      await runOpencode(
        `Use the gpt_imagegen tool to generate an image at character.png. ` +
          `Content: a man wearing a navy-blue samue and a red hachimaki headband, standing in a garden of cherry blossoms in full bloom. ` +
          `Style: ${STYLE}. Size: 1024x1536 (portrait).`,
      )
      const out = path.join(WORKDIR, "character.png")
      const buf = await assertPng(out)
      const { width, height } = readPngDimensions(buf)
      expect(width).toBe(1024)
      expect(height).toBe(1536)
      // Without a background request, the plugin sends opaque and the backend returns RGB (color type 2).
      expect(readPngColorType(buf)).toBe(2)
      console.log(`A: ${out}`)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "B. woman landscape 1536x1024 (auto-versioned)",
    async () => {
      await runOpencode(
        `Use the gpt_imagegen tool to generate an image at character.png. ` +
          `Content: a woman wearing a yellow yukata and holding a red wagasa parasol, standing in a garden at night with fireflies dancing around her. ` +
          `Style: ${STYLE}. Size: 1536x1024 (landscape).`,
      )
      const out = path.join(WORKDIR, "character-v2.png")
      const buf = await assertPng(out)
      const { width, height } = readPngDimensions(buf)
      expect(width).toBe(1536)
      expect(height).toBe(1024)
      console.log(`B: ${out}`)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "C. compose two characters from A and B references",
    async () => {
      await runOpencode(
        `Use the gpt_imagegen tool to generate an image at together.png. ` +
          `Pass ./character.png and ./character-v2.png in the images argument. ` +
          `Content: the man from Image 1 (navy samue + red hachimaki) and the woman from Image 2 (yellow yukata + red wagasa) standing side by side ` +
          `on the engawa veranda of an old Japanese house, smiling at the viewer. ` +
          `Preserve each character's outfit, hairstyle, and props exactly. ` +
          `Style: ${STYLE}. Size: 1672x941.`,
      )
      const out = path.join(WORKDIR, "together.png")
      const buf = await assertPng(out)
      const { width, height } = readPngDimensions(buf)
      // The backend sometimes returns this size with an edge 1px off (e.g. 1672x940).
      expect(Math.abs(width - 1672)).toBeLessThanOrEqual(1)
      expect(Math.abs(height - 941)).toBeLessThanOrEqual(1)
      console.log(`C: ${out}`)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "D. sticker with a transparent background",
    async () => {
      await runOpencode(
        `Use the gpt_imagegen tool to generate an image at sticker.png. ` +
          `Content: a sticker of a red paper lantern with a transparent background. ` +
          `Style: ${STYLE}. Size: 1254x1254.`,
      )
      const out = path.join(WORKDIR, "sticker.png")
      const buf = await assertPng(out)
      expect(readPngColorType(buf)).toBe(6)
      console.log(`D: ${out}`)
    },
    TEST_TIMEOUT_MS,
  )
})
