// A 1x1 transparent PNG, recognized by file-type from its header bytes.
export const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=="

export const PNG_BUFFER = Buffer.from(PNG_BASE64, "base64")

export function pngDataUrl(buf: Buffer): string {
  return `data:image/png;base64,${buf.toString("base64")}`
}
