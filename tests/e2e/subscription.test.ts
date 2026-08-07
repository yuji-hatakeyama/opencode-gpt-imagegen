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

async function buildPlugin(): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn("bun", ["run", "build"], {
      cwd: REPO_DIR,
      stdio: "inherit",
    })
    proc.on("error", reject)
    proc.on("close", (code) => {
      if (code !== 0) reject(new Error(`bun run build failed (exit=${code})`))
      else resolve()
    })
  })
}

async function writeOpencodeConfig(): Promise<void> {
  const cfgDir = path.join(XDG_CONFIG_HOME, "opencode")
  await mkdir(cfgDir, { recursive: true })
  const config = {
    $schema: "https://opencode.ai/config.json",
    plugin: [pathToFileURL(REPO_DIR).href],
  }
  await writeFile(path.join(cfgDir, "opencode.jsonc"), JSON.stringify(config, null, 2))
}

async function runOpencode(prompt: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["run", prompt, "--dir", WORKDIR, "--dangerously-skip-permissions"]
    if (process.env.OPENCODE_MODEL) args.push("--model", process.env.OPENCODE_MODEL)
    const proc = spawn("opencode", args, {
      stdio: "inherit",
      env: { ...process.env, XDG_CONFIG_HOME },
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

function assertDimensions(buf: Buffer, expectedWidth: number, expectedHeight: number): void {
  const { width, height } = readPngDimensions(buf)
  // The backend model occasionally transposes the requested orientation. The `size` string is
  // passed correctly, so a swapped result is a known real-API flake, not a plugin regression — re-run.
  if (width === expectedHeight && height === expectedWidth) {
    throw new Error(
      `expected ${expectedWidth}x${expectedHeight} but got ${width}x${height} (orientation transposed); ` +
        `the model occasionally swaps width/height — known flake, re-run the e2e`,
    )
  }
  expect(width).toBe(expectedWidth)
  expect(height).toBe(expectedHeight)
}

describe("gpt_imagegen e2e (subscription)", () => {
  beforeAll(async () => {
    console.log(`WORKDIR: ${WORKDIR}`)
    console.log(`XDG_CONFIG_HOME: ${XDG_CONFIG_HOME}`)
    await buildPlugin()
    await writeOpencodeConfig()
  })

  test(
    "A. man portrait 1024x1536",
    async () => {
      await runOpencode(
        `Use the gpt_imagegen tool to generate an image at character.png. ` +
          `Content: a man wearing a navy-blue samue and a red hachimaki headband, standing in a garden of cherry blossoms in full bloom. ` +
          `Style: ${STYLE}. Size: 1024x1536 (portrait). Quality: medium.`,
      )
      const out = path.join(WORKDIR, "character.png")
      const buf = await assertPng(out)
      assertDimensions(buf, 1024, 1536)
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
          `Style: ${STYLE}. Size: 1536x1024 (landscape). Quality: medium.`,
      )
      const out = path.join(WORKDIR, "character-v2.png")
      const buf = await assertPng(out)
      assertDimensions(buf, 1536, 1024)
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
          `Style: ${STYLE}. Size: 2048x1152. Quality: medium.`,
      )
      const out = path.join(WORKDIR, "together.png")
      await assertPng(out)
      console.log(`C: ${out}`)
    },
    TEST_TIMEOUT_MS,
  )
})
