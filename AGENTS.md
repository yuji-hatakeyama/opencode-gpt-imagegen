# AGENTS.md

## Contribution Policy

If you are helping someone other than the maintainer (@yuji-hatakeyama) contribute, read [CONTRIBUTING.md](CONTRIBUTING.md) before you write code, and follow it.

When you open a pull request, including one for the maintainer, write its description by filling in [.github/pull_request_template.md](.github/pull_request_template.md). Write its title as described in [CONTRIBUTING.md](CONTRIBUTING.md#commit-messages-and-pull-request-titles).

## Project Shape

- Bun is the package manager/runtime; use `bun install --frozen-lockfile` with the committed `bun.lock`.
- The plugin entry is `src/index.ts`, which exposes V1 `server` and V2 `setup`. Adapters in `src/v1.ts` and `src/v2.ts` translate host registration, credentials, session directories, and results. `src/imagegen.ts` owns the shared schema, description, validation, and generation flow. Image helpers retain their role-based modules.
- Both SDKs are development-only type dependencies. Zod is a direct runtime dependency. V2 converts the shared schema to JSON Schema with the plugin's own Zod instance so descriptions survive a different host Zod registry.
- `bun run build` bundles `src` into a single self-contained `dist/index.js` via `bun build --target node --format esm --packages external` (runtime dependencies stay external). Bundling avoids the extensionless relative imports `tsc` would emit, which native Node ESM cannot resolve. No `.d.ts` is published — the plugin is loaded by OpenCode at runtime, not imported as a typed library.
- `dist/` is ignored locally but is the publish artifact (just `index.js`). Run `bun run build` before inspecting package output.
- `bunfig.toml` enforces `install.minimumReleaseAge = 604800` (1 week): newly published versions are filtered out by `bun install` / `bun add` / `bun outdated`.

## Commands

- Tests are split by kind: `tests/unit/` (unit tests of the `src/` modules, including the plugin entry) and `tests/e2e/` (`gpt_imagegen.test.ts`).
- `bun run typecheck` runs `tsc --noEmit` over `src` and `tests`.
- `bunx biome ci .` is the CI formatter/linter check.
- `bun run check` runs `biome check --write .`; it may modify files.
- `bun run test` runs `bun test tests/unit` — unit tests only, and is what CI uses. (A bare `bun test` would also discover the e2e files under `tests/e2e/` and try to run them for real, so prefer the script.)
- `bun run test:e2e` sets `OPENCODE_MODEL=openai/gpt-6-sol` and runs `tests/e2e/gpt_imagegen.test.ts` in its own `bun test` process, which keeps the unit tests' `process.env` edits out of the e2e `opencode` spawn. It can take minutes because it calls `opencode run` and generates real images.
- CI runs `bun run typecheck`, `bunx biome ci .`, and `bun run test`. It does not run `bun run test:e2e`, which needs real auth and generations.

## E2E Requirements

- `tests/e2e/gpt_imagegen.test.ts` prints the CLI version and runs OpenCode V2 with `--standalone` in a temporary workdir. It isolates configuration while retaining the credential data directory. Its configuration denies all tools except `gpt_imagegen` so the agent cannot modify generated files with other tools.
- E2E requires the active OpenAI connection to use Codex browser or device-code OAuth. V2 resolves and refreshes credentials through OpenCode. Token-sharing sign-in is not supported for images. V1 separately retains `OPENCODE_AUTH_CONTENT`, then `$XDG_DATA_HOME/opencode/auth.json`.
- The e2e tests assert that produced files are valid PNGs, and cover the plugin's output auto-versioning and transparent backgrounds.
- The README Usage examples show the e2e prompts and example outputs. When cases or prompts change, keep the README prompts (with `${STYLE}` expanded) and example count in sync.
- Replace example images only when a prompt or image-generation model change makes the existing illustrations unsuitable. Routine E2E runs and harness changes do not require replacing images. When a refresh is needed, use the outputs of one passing run for all examples, because Example C uses A and B as references. The test logs each output path.

## Implementation Notes

- The exposed tool is `gpt_imagegen`; it calls the ChatGPT Codex Images endpoints, `images/generations`, or `images/edits` when reference images are given.
- The `baseURL` plugin option points those requests at a proxy serving the same endpoints instead; the proxy holds the ChatGPT credentials, so neither adapter looks up authentication and no credentials are sent.
- Output paths are resolved relative to the OpenCode context directory unless absolute, and existing files are never overwritten; suffixes `-v2` through `-v999` are tried.
- Reference images are read from paths relative to the OpenCode context directory and are embedded as data URLs after MIME detection.

## Publishing

- `package.json` `files` intentionally publishes only `dist`, `README.md`, and `LICENSE`.
- `prepublishOnly` runs `bun run build`, so `npm publish` always rebuilds `dist/` first.
- Release flow: run `bun run release:patch` (or `:minor` / `:major`) on a clean `main`. The npm script chains `scripts/prepare-release.sh <level>` (preflight, diff review, version bump) with `git push --follow-tags`. The shell script checks the working tree is clean and in sync with `origin/main`, prints the commits since the previous tag along with a GitHub compare URL for diff review, asks for confirmation, and runs `npm version <level>` to create the `chore: release X.Y.Z` commit and `vX.Y.Z` tag locally; the push happens only on success.
- The tag push triggers `.github/workflows/release.yml`, which runs `npm publish --provenance --access public` via npm OIDC trusted publisher (no `NPM_TOKEN` secret) and creates a GitHub release with auto-generated notes. The npm package must have GitHub Actions registered as a trusted publisher on npmjs.com for OIDC to work.
- Release notes are generated from pull request titles. If the release includes a breaking change (a title with `!`, such as `feat!:`), edit the GitHub release after the workflow creates it, and add a `Breaking changes` section at the top. For each change, write what changed and how users should update their usage, and link the pull request, for example:

  ```markdown
  ## Breaking changes

  - `size` is now required and accepts only `1254x1254`, `1536x1024`, `1024x1536`, `1448x1086`, `1086x1448`, `1672x941`, and `941x1672`. `auto` and other sizes are rejected. Pick the size with the closest aspect ratio and resize the output locally. (#108)
  ```
