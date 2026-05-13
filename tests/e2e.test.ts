import { beforeAll, describe, expect, test } from "bun:test"
import { spawn } from "node:child_process"
import { existsSync } from "node:fs"
import { mkdtemp, readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const WORKDIR = await mkdtemp(path.join(os.tmpdir(), "qa-imagegen-"))
const RUN_TIMEOUT_MS = 300_000
const TEST_TIMEOUT_MS = RUN_TIMEOUT_MS + 10_000
const STYLE = "hand-drawn 90s Japanese animation style"

async function runOpencode(prompt: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = ["run", prompt, "--dir", WORKDIR, "--dangerously-skip-permissions"]
    if (process.env.OPENCODE_MODEL) args.push("--model", process.env.OPENCODE_MODEL)
    const proc = spawn("opencode", args, { stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", (d) => {
      stdout += d.toString()
    })
    proc.stderr.on("data", (d) => {
      stderr += d.toString()
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
      const summary = `exit=${code ?? "null"} signal=${signal ?? "null"}\n--- stdout ---\n${stdout.trim()}\n--- stderr ---\n${stderr.trim()}`
      console.log(summary)
      if (signal === "SIGTERM") {
        reject(new Error(`opencode run timed out after ${RUN_TIMEOUT_MS}ms.\n${summary}`))
        return
      }
      if (code !== 0) {
        reject(new Error(`opencode run failed.\n${summary}`))
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

describe.skipIf(!process.env.RUN_E2E)("gpt_image_gen e2e", () => {
  beforeAll(() => {
    console.log(`workdir: ${WORKDIR}`)
  })

  test(
    "A. man portrait 1024x1536",
    async () => {
      await runOpencode(
        `Use the gpt_image_gen tool to generate an image at character.png. ` +
          `Content: a man wearing a navy-blue samue and a red hachimaki headband, standing in a garden of cherry blossoms in full bloom. ` +
          `Style: ${STYLE}. Size: 1024x1536 (portrait). Quality: medium.`,
      )
      const out = path.join(WORKDIR, "character.png")
      const buf = await assertPng(out)
      const { width, height } = readPngDimensions(buf)
      expect(width).toBe(1024)
      expect(height).toBe(1536)
      console.log(`A: ${out}`)
    },
    TEST_TIMEOUT_MS,
  )

  test(
    "B. woman landscape 1536x1024 (auto-versioned)",
    async () => {
      await runOpencode(
        `Use the gpt_image_gen tool to generate an image at character.png. ` +
          `Content: a woman wearing a yellow yukata and holding a red wagasa parasol, standing in a garden at night with fireflies dancing around her. ` +
          `Style: ${STYLE}. Size: 1536x1024 (landscape). Quality: medium.`,
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
        `Use the gpt_image_gen tool to generate an image at together.png. ` +
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
