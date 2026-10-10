// The Codex backend ignores the requested pixel size, outputs about 1024x1536 pixels in total,
// and takes only the aspect ratio from the prompt. These sizes fit that pixel count, so they come out exactly or within 1px.
// https://github.com/yuji-hatakeyama/opencode-gpt-imagegen/issues/107
export const IMAGE_SIZES = {
  "1254x1254": "1:1",
  "1536x1024": "3:2",
  "1024x1536": "2:3",
  "1448x1086": "4:3",
  "1086x1448": "3:4",
  "1672x941": "16:9",
  "941x1672": "9:16",
} as const

export type ImageSize = keyof typeof IMAGE_SIZES

export const SIZE_CHOICES = Object.entries(IMAGE_SIZES)
  .map(([size, aspectRatio]) => `${size} (${aspectRatio})`)
  .join(", ")

function isImageSize(value: string): value is ImageSize {
  return Object.hasOwn(IMAGE_SIZES, value)
}

// The tool schema already limits `size` to IMAGE_SIZES, but some OpenCode versions (e.g. 1.18.34)
// do not validate plugin tool arguments before calling execute, so check it here as well.
export function parseImageSize(value: string | undefined): ImageSize | undefined {
  if (value === undefined) return undefined
  if (!isImageSize(value)) {
    throw new Error(`Unsupported size "${value}". Use one of: ${SIZE_CHOICES}.`)
  }
  return value
}

export function appendSizeToPrompt(prompt: string, size: ImageSize | undefined): string {
  if (!size) return prompt
  const [width, height] = size.split("x")
  return `${prompt} Generate the image with a width of ${width} pixels and a height of ${height} pixels (${IMAGE_SIZES[size]} aspect ratio).`
}
