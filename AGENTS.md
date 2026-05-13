# AGENTS.md

## Project Shape

- Bun is the package manager/runtime; use `bun install --frozen-lockfile` with the committed `bun.lock`.
- The plugin source is `src/index.ts`; package exports point at generated `dist/index.js` and `dist/index.d.ts`.
- `dist/` is ignored locally but is the publish artifact. Run `bun run build` before inspecting package output.
- `bunfig.toml` enforces `install.minimumReleaseAge = 604800` (1 week): newly published versions are filtered out by `bun install` / `bun add` / `bun outdated`.

## Commands

- `bun run typecheck` runs `tsc --noEmit` over `src` and `tests`.
- `bunx biome ci .` is the CI formatter/linter check.
- `bun run check` runs `biome check --write .`; it may modify files.
- `bun test` runs Bun tests, but the current e2e suite is skipped unless `RUN_E2E` is set.
- `bun run test:e2e` sets `RUN_E2E=1 OPENCODE_MODEL=openai/gpt-5.5` and can take minutes because it calls `opencode run` and generates real images.
- CI currently runs only `bun run typecheck` and `bunx biome ci .`; it does not run `bun test`.

## E2E Requirements

- `tests/e2e.test.ts` shells out to the `opencode` CLI with `--dangerously-skip-permissions` in a temporary workdir.
- E2E requires OpenCode to be authenticated with ChatGPT OAuth; the plugin reads `OPENCODE_AUTH_CONTENT` first, then `$XDG_DATA_HOME/opencode/auth.json`.
- The e2e tests assert that produced files are valid PNGs and cover the plugin's output auto-versioning behavior.

## Implementation Notes

- The exposed tool is `gpt_image_gen`; it calls the ChatGPT Codex responses endpoint with the hosted `image_generation` tool.
- Output paths are resolved relative to the OpenCode context directory unless absolute, and existing files are never overwritten; suffixes `-v2` through `-v999` are tried.
- Reference images are read from paths relative to the OpenCode context directory and are embedded as data URLs after MIME detection.

## Publishing

- `package.json` `files` intentionally publishes only `dist`, `README.md`, and `LICENSE`.
- `prepublishOnly` runs `bun run build`, so `npm publish` always rebuilds `dist/` first.
