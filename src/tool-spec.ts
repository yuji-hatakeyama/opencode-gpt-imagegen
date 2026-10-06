// Tool metadata shared by the v1 (zod) and v2 (JSON Schema) registrations, so the
// model sees identical tool descriptions whichever plugin API OpenCode loads.
export const TOOL_DESCRIPTION = [
  "Generate raster images using OpenAI's hosted image_generation tool.",
  "Use for AI-created bitmap visuals such as photos, illustrations, textures, sprites, and mockups.",
  "Do not use when the task is better handled by editing existing SVG/vector/code-native assets, extending an established icon or logo system, or building the visual directly in HTML/CSS/canvas.",
  "Reference images may be attached through `images`; label each image's role inline in `prompt`, for example: 'Image 1: reference image'.",
  "For many distinct assets, invoke gpt_imagegen once per requested asset rather than relying on multi-image output; gpt_imagegen returns one image per call.",
  "Requires OpenCode to be authenticated with ChatGPT OAuth. Returns the absolute path of the saved PNG.",
].join(" ")

export const FIELD_DESCRIPTIONS = {
  prompt: "Description of the image to generate.",
  out: "Output file path, relative to the project directory unless absolute. The plugin writes a PNG.",
  quality: "Generation quality passed to the hosted image_generation tool.",
  size: "Optional image size passed to the hosted image_generation tool. Use `auto` or `WIDTHxHEIGHT`; width and height must be multiples of 16px, max edge <= 3840px, long-to-short ratio <= 3:1, and total pixels between 655,360 and 8,294,400.",
  images: "Optional reference image paths, relative to the project directory unless absolute.",
} as const

// JSON Schema form of the tool input, used by the OpenCode v2 tool API.
export const TOOL_INPUT_SCHEMA = {
  type: "object",
  properties: {
    prompt: { type: "string", description: FIELD_DESCRIPTIONS.prompt },
    out: { type: "string", description: FIELD_DESCRIPTIONS.out },
    quality: {
      type: "string",
      enum: ["low", "medium", "high", "auto"],
      description: FIELD_DESCRIPTIONS.quality,
    },
    size: { type: "string", description: FIELD_DESCRIPTIONS.size },
    images: {
      type: "array",
      items: { type: "string" },
      description: FIELD_DESCRIPTIONS.images,
    },
  },
  required: ["prompt", "out", "quality"],
  additionalProperties: false,
} as const
