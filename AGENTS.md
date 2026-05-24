# AGENTS.md

## Project Shape

- Bun is the package manager/runtime; use `bun install --frozen-lockfile` with the committed `bun.lock`.
- The plugin entry is `src/index.ts` (plugin wiring + tool schema); helpers live in role-based modules — `src/types.ts` (shared types), `src/auth.ts` (auth resolution), `src/input-image.ts` (reference image reading), `src/output-image.ts` (non-overwriting save + message), `src/codex.ts` (Codex backend call + SSE parsing).
- `bun run build` bundles `src` into a single self-contained `dist/index.js` via `bun build --target node --format esm --packages external` (dependencies, including the `@opencode-ai/plugin` peer dep, stay external). Bundling avoids the extensionless relative imports `tsc` would emit, which native Node ESM cannot resolve. No `.d.ts` is published — the plugin is loaded by OpenCode at runtime, not imported as a typed library.
- `dist/` is ignored locally but is the publish artifact (just `index.js`). Run `bun run build` before inspecting package output.
- `bunfig.toml` enforces `install.minimumReleaseAge = 604800` (1 week): newly published versions are filtered out by `bun install` / `bun add` / `bun outdated`.

## Commands

- `bun run typecheck` runs `tsc --noEmit` over `src` and `tests`.
- `bunx biome ci .` is the CI formatter/linter check.
- `bun run check` runs `biome check --write .`; it may modify files.
- `bun test` runs Bun tests: the helper-module unit tests always run; the e2e suite is skipped unless `RUN_E2E` is set.
- `bun run test:e2e` sets `RUN_E2E=1 OPENCODE_MODEL=openai/gpt-5.5` and can take minutes because it calls `opencode run` and generates real images.
- CI runs `bun run typecheck`, `bunx biome ci .`, and `bun test`. `bun test` covers the unit tests only; the e2e suite is skipped because `RUN_E2E` is unset in CI.

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
- Release flow: run `bun run release:patch` (or `:minor` / `:major`) on a clean `main`. The npm script chains `scripts/prepare-release.sh <level>` (preflight, diff review, version bump) with `git push --follow-tags`. The shell script checks the working tree is clean and in sync with `origin/main`, prints the commits since the previous tag along with a GitHub compare URL for diff review, asks for confirmation, and runs `npm version <level>` to create the `chore: release X.Y.Z` commit and `vX.Y.Z` tag locally; the push happens only on success.
- The tag push triggers `.github/workflows/release.yml`, which runs `npm publish --provenance --access public` via npm OIDC trusted publisher (no `NPM_TOKEN` secret) and creates a GitHub release with auto-generated notes. The npm package must have GitHub Actions registered as a trusted publisher on npmjs.com for OIDC to work.
