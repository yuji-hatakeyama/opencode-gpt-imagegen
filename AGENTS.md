# AGENTS.md

## Project Shape

- Bun is the package manager/runtime; use `bun install --frozen-lockfile` with the committed `bun.lock`.
- The plugin entry is `src/index.ts` (plugin wiring + tool schema); helpers live in role-based modules — `src/types.ts` (shared types), `src/auth.ts` (auth resolution), `src/input-image.ts` (reference image reading), `src/output-image.ts` (non-overwriting save + message), `src/codex.ts` (Codex backend call + SSE parsing).
- `bun run build` bundles `src` into a single self-contained `dist/index.js` via `bun build --target node --format esm --packages external` (dependencies, including the `@opencode-ai/plugin` peer dep, stay external). Bundling avoids the extensionless relative imports `tsc` would emit, which native Node ESM cannot resolve. No `.d.ts` is published — the plugin is loaded by OpenCode at runtime, not imported as a typed library.
- `dist/` is ignored locally but is the publish artifact (just `index.js`). Run `bun run build` before inspecting package output.
- `bunfig.toml` enforces `install.minimumReleaseAge = 604800` (1 week): newly published versions are filtered out by `bun install` / `bun add` / `bun outdated`.

## Commands

- Tests are split by kind: `tests/unit/` (helper-module unit tests) and `tests/e2e/` (one file per auth path, e.g. `subscription.test.ts`).
- `bun run typecheck` runs `tsc --noEmit` over `src` and `tests`.
- `bunx biome ci .` is the CI formatter/linter check.
- `bun run check` runs `biome check --write .`; it may modify files.
- `bun run test` runs `bun test tests/unit` — unit tests only, and is what CI uses. (A bare `bun test` would also discover the e2e files under `tests/e2e/` and try to run them for real, so prefer the script.)
- `bun run test:e2e_subscription` sets `OPENCODE_MODEL=openai/gpt-5.5` and runs `tests/e2e/subscription.test.ts` (ChatGPT subscription / OAuth path). It can take minutes because it calls `opencode run` and generates real images. The future API-key path gets its own `test:e2e_apikey` script + `tests/e2e/apikey.test.ts`.
- Each e2e path is its own script (its own `bun test` process), which also avoids the unit-test `process.env` leak into the single-process e2e `opencode` spawn.
- CI runs `bun run typecheck`, `bunx biome ci .`, and `bun run test`. The e2e suites are not run in CI's default checks (they need real auth + generations); they are invoked separately via their `test:e2e_*` scripts.

## E2E Requirements

- `tests/e2e.test.ts` shells out to the `opencode` CLI with `--dangerously-skip-permissions` in a temporary workdir.
- E2E requires OpenCode to be authenticated with ChatGPT OAuth; the plugin reads `OPENCODE_AUTH_CONTENT` first, then `$XDG_DATA_HOME/opencode/auth.json`.
- The e2e tests assert that produced files are valid PNGs and cover the plugin's output auto-versioning behavior.

## Implementation Notes

- The exposed tool is `gpt_imagegen`; it calls the ChatGPT Codex responses endpoint with the hosted `image_generation` tool.
- Output paths are resolved relative to the OpenCode context directory unless absolute, and existing files are never overwritten; suffixes `-v2` through `-v999` are tried.
- Reference images are read from paths relative to the OpenCode context directory and are embedded as data URLs after MIME detection.

## Publishing

- `package.json` `files` intentionally publishes only `dist`, `README.md`, and `LICENSE`.
- `prepublishOnly` runs `bun run build`, so `npm publish` always rebuilds `dist/` first.
- Release flow: run `bun run release:patch` (or `:minor` / `:major`) on a clean `main`. The npm script chains `scripts/prepare-release.sh <level>` (preflight, diff review, version bump) with `git push --follow-tags`. The shell script checks the working tree is clean and in sync with `origin/main`, prints the commits since the previous tag along with a GitHub compare URL for diff review, asks for confirmation, and runs `npm version <level>` to create the `chore: release X.Y.Z` commit and `vX.Y.Z` tag locally; the push happens only on success.
- The tag push triggers `.github/workflows/release.yml`, which runs `npm publish --provenance --access public` via npm OIDC trusted publisher (no `NPM_TOKEN` secret) and creates a GitHub release with auto-generated notes. The npm package must have GitHub Actions registered as a trusted publisher on npmjs.com for OIDC to work.
