# Contributing

This plugin is maintained by one person and aims to keep a small feature set.

## What to contribute

- Small bug fixes are welcome as pull requests. "Small" means roughly 10 lines changed in `src/`, not counting tests and docs.
- For features, refactors, behavior changes, and larger fixes, please open an [issue](https://github.com/yuji-hatakeyama/opencode-gpt-imagegen/issues/new) first and wait for agreement before writing code. Even if the code is already written, I may not be able to review or accept large changes.

## Development setup

- Use npm 11.10.0 or later, as `devEngines` in `package.json` requires. Node.js 24.14.1 or later and Node.js 26 include it.
- Install [Bun](https://bun.com/). The npm scripts use Bun to build and test.
- npm manages the dependencies. Run `npm ci` to install them, and use npm to add, update, or remove a dependency, for example `npm install <package>`.
- Do not manage dependencies with Bun, such as `bun install`, `bun add`, `bun update`, or `bun remove`. Bun does not update `package-lock.json`, so CI fails.
- Run every other task through the npm scripts, such as `npm run lint`, `npm test`, and `npm run fix` to fix lint and format errors.

## Before you open a pull request

- [MUST] `npm run typecheck` passes.
- [MUST] `npm run lint` passes.
- [MUST] `npm test` passes.

## Commit messages and pull request titles

- Follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/), for example `fix: ...`, `feat: ...`, or `docs: ...`.
- Pull request titles become the entries of the release notes. Describe what changes for plugin users rather than how the code changes.
- If the change breaks existing usage, for example by removing or restricting a `gpt_imagegen` argument, add `!` after the type, for example `feat!: ...`.
