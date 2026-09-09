# ADR 0001: Port image generation from the hosted Responses tool to the Codex images endpoint

- Status: Accepted (implementation in progress; see [Task list](#task-list))
- Date: 2026-09-10 (supersedes the research note written on 2026-07-13)
- Codex reference commit: [`c77c34ed33877a6e5b3759703d01d3b223274cbf`](https://github.com/openai/codex/commit/c77c34ed33877a6e5b3759703d01d3b223274cbf) (main, 2026-09-09). Every permalink below and in `src/` points at this commit so a future port can diff against it.

## Context

This plugin mirrors how the openai/codex CLI generates images on a ChatGPT subscription. Until now it reproduced the original path: a single-turn `POST /backend-api/codex/responses` request with the hosted `image_generation` tool attached, parsing the image out of the SSE stream.

Codex no longer uses that path. It moved to a dedicated images endpoint called by an extension, and removed the built-in pipeline:

| Date | Codex change | Effect |
|---|---|---|
| 2026-03-04 | [#13290](https://github.com/openai/codex/pull/13290) "image-gen-core" | Hosted Responses `image_generation` tool introduced |
| 2026-04-16 | [#17153](https://github.com/openai/codex/pull/17153) | Hosted tool enabled by default |
| 2026-05-22 | [#23989](https://github.com/openai/codex/pull/23989) | Typed `ImagesClient` (`images/generations`, `images/edits`) added to `codex-api` |
| 2026-05-28 | [#24723](https://github.com/openai/codex/pull/24723) | `codex-image-generation-extension` added behind a feature gate; tool `image_gen.imagegen`, model fixed to `gpt-image-2`, "uses automatic image parameters" |
| 2026-07-09 | [#31596](https://github.com/openai/codex/pull/31596) | Extension becomes the default; hosted tool no longer advertised for new turns |
| 2026-07-08 | [#31597](https://github.com/openai/codex/pull/31597) | Built-in hosted pipeline removed |
| 2026-07-16 | [#33677](https://github.com/openai/codex/pull/33677) | Extension forwards the thread `originator` header |
| 2026-07-30 | [#36092](https://github.com/openai/codex/pull/36092) | `x-codex-image-turn-id` request header added |
| 2026-08-11 | [#38024](https://github.com/openai/codex/pull/38024) | 429 `usage_limit_reached` with `limit_id=image_gen` surfaced as a typed failure |
| 2026-08-17 | [#39072](https://github.com/openai/codex/pull/39072) | Generated images persisted through turn executors (`{cwd}/generated_images/`) |
| 2026-08-25 | [#40714](https://github.com/openai/codex/pull/40714) | `x-codex-imagegen-request-id` response header recorded for analytics |
| 2026-09-09 | [#43953](https://github.com/openai/codex/pull/43953) | `data[].generation_id` recorded for analytics |

Stated motivations, quoted from the PR descriptions: "Image generation should have one implementation path" (#31596); the extension "can be exercised independently of hosted Responses image generation" (#24723); "The initial extension contract intentionally fixes the image model to `gpt-image-2` and uses automatic image parameters" (#24723).

No official statement says how long the Responses backend keeps accepting the hosted tool. Codex itself stopped sending it, so the old path has no guaranteed support.

### GPT-Image 2.5

OpenAI announced "ChatGPT Images 2.5" on 2026-09-08. The public API ids are `gpt-image-2.5-flare` and `gpt-image-2.5-sunburst`; there is no bare `gpt-image-2.5` id. At the reference commit, codex still fixes `IMAGE_MODEL` to `gpt-image-2` ([tool.rs#L58](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/ext/image-generation/src/tool.rs#L58)) and no PR or code references the 2.5 ids ([issue #43965](https://github.com/openai/codex/issues/43965) asks about it, unanswered). Bumping the model is out of scope for this ADR and will be a separate change once codex moves.

Sources: [gpt-image-2.5-flare model page](https://developers.openai.com/api/docs/models/gpt-image-2.5-flare), [gpt-image-2.5-sunburst model page](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst), [announcement on the developer community](https://community.openai.com/t/introducing-gpt-images-2-5-in-the-api-and-chatgpt/1395897).

## What codex does at the reference commit

The request the plugin must mirror is assembled in these places:

- Endpoint: `{base}/images/generations` without reference images, `{base}/images/edits` with them ([images.rs#L35-L55](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/codex-api/src/endpoint/images.rs#L35-L55)). `base` for ChatGPT auth is `https://chatgpt.com/backend-api/codex` ([lib.rs#L43](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/model-provider-info/src/lib.rs#L43), [lib.rs#L349-L366](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/model-provider-info/src/lib.rs#L349-L366)).
- Body: `{prompt, background: "auto", model: "gpt-image-2", quality: "auto", size: "auto"}`; edits add `images: [{image_url}]` in front ([tool.rs#L432-L439](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/ext/image-generation/src/tool.rs#L432-L439), [tool.rs#L479-L487](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/ext/image-generation/src/tool.rs#L479-L487), types in [images.rs#L4-L31](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/codex-api/src/images.rs#L4-L31)). `n` is never sent.
- Headers: `Authorization: Bearer` and `ChatGPT-Account-ID` ([bearer_auth_provider.rs#L32-L46](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/model-provider/src/bearer_auth_provider.rs#L32-L46)); `x-codex-image-turn-id: {turn_id}` and the thread `originator` ([backend.rs#L113-L122](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/ext/image-generation/src/backend.rs#L113-L122)); the default client adds `User-Agent` and `originator: codex_cli_rs` ([default_client.rs#L40](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/login/src/auth/default_client.rs#L40), [default_client.rs#L137-L151](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/login/src/auth/default_client.rs#L137-L151)).
- Retry: up to `DEFAULT_REQUEST_MAX_RETRIES = 4` retries (5 attempts), base delay 200 ms, exponential backoff with 0.9 to 1.1 jitter, on 5xx and transport errors only; 429 is not retried ([lib.rs#L31](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/model-provider-info/src/lib.rs#L31), [lib.rs#L371-L377](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/model-provider-info/src/lib.rs#L371-L377), [retry.rs#L22-L48](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/codex-client/src/retry.rs#L22-L48), [retry.rs#L80-L107](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/codex-client/src/retry.rs#L80-L107)).
- Response: JSON `{created, data: [{b64_json, generation_id?}], background?, quality?, size?}` ([images.rs#L55-L72](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/codex-api/src/images.rs#L55-L72)); the first `data` element is used and an empty array is "image generation returned no image data" ([tool.rs#L185-L197](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/ext/image-generation/src/tool.rs#L185-L197)). The `x-codex-imagegen-request-id` response header is read for analytics ([images.rs#L16](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/codex-api/src/endpoint/images.rs#L16), [images.rs#L71-L76](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/codex-api/src/endpoint/images.rs#L71-L76)).
- Errors: non-2xx becomes `TransportError::Http` rendered as `http {status}: {body:?}` ([transport.rs#L114-L131](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/http-client/src/transport.rs#L114-L131), [error.rs#L10](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/http-client/src/error.rs#L10)); undecodable JSON becomes `stream error: failed to decode image generation response: ...` ([images.rs#L77-L78](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/codex-api/src/endpoint/images.rs#L77-L78)); the tool wraps everything as `image generation failed: {message}` ([tool.rs#L172-L177](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/ext/image-generation/src/tool.rs#L172-L177)).
- Model-facing args: `prompt`, `referenced_image_paths` (max 5), `num_last_images_to_include` (1 to 5), mutually exclusive ([tool.rs#L86-L95](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/ext/image-generation/src/tool.rs#L86-L95), [tool.rs#L419-L488](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/ext/image-generation/src/tool.rs#L419-L488), [imagegen_description.md](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/ext/image-generation/imagegen_description.md)).
- Reference images: read from absolute paths; PNG, JPEG and WebP are passed through byte for byte, other formats (e.g. GIF) are re-encoded to PNG ([tool.rs#L552-L578](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/ext/image-generation/src/tool.rs#L552-L578), [utils/image lib.rs#L354-L361](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/utils/image/src/lib.rs#L354-L361)).
- Output: saved to `generated_images/{session}/{call_id}.png` and the model receives the image plus a hint telling it to copy rather than move the file ([artifact.rs#L38-L48](https://github.com/openai/codex/blob/c77c34ed33877a6e5b3759703d01d3b223274cbf/codex-rs/ext/image-generation/src/artifact.rs#L38-L48)).

### Empirical verification (2026-09-10, ChatGPT subscription OAuth token)

Two direct `POST /backend-api/codex/images/generations` calls with the codex body:

| Request | Result |
|---|---|
| `size: "1536x1024"` in the body, no dimensions in the prompt | 200, PNG 1254x1254, response `quality: "low"`. The structured field is ignored. |
| `size: "auto"`, prompt ends with `Output image size — width: 1024px, height: 1536px.` | 200, PNG 1024x1536, response `quality: "medium"`. Dimensions in the prompt are honored exactly. |

Both requests carried a non-UUID `x-codex-image-turn-id` and were accepted. Both responses carried `x-codex-imagegen-request-id`; `data[0]` had only `b64_json` (no `generation_id`). This matches the 2026-07-13 finding that the backend derives quality and size from the prompt, which is consistent with codex sending `auto` for both.

## Decision

1. Replace the Responses + hosted tool call with the codex images endpoint, mirroring the request above field for field: `gpt-image-2`, `background`/`quality`/`size` fixed to `auto`, `images/edits` when reference images are present.
2. Port codex's retry policy (5 attempts, 200 ms exponential backoff with jitter, 5xx and transport errors only) and its error message layering.
3. Send `x-codex-image-turn-id` with the OpenCode message id, since codex correlates image requests with turns this way. Keep `originator: opencode`.
4. Keep the plugin's own tool contract where it is not part of the request mirror: `out` (save location), `size` (restated in the prompt because that is the only working dimension control), `images` (keeps its current name). Cap `images` at codex's `MAX_EDIT_IMAGES = 5`.
5. Drop the `quality` argument: the backend ignores it and codex deliberately sends `auto`. Callers that still pass it get a schema-strip rather than an error.
6. Do not port `num_last_images_to_include`. Codex resolves it from the conversation history, which the OpenCode plugin API does not expose. This was decided by the maintainer for this ADR.
7. Do not bump to a gpt-image-2.5 id (see above).
8. Remove the `eventsource-parser` dependency; the endpoint returns plain JSON.
9. Adopt codex's output hint wording for the versioned-save message so the calling agent copies rather than moves the file. Observed in e2e runs: without this, agents `mv` the versioned file onto the requested path, defeating the non-overwrite guarantee.

## Intentional deviations from codex

Everything not listed here mirrors codex at the reference commit (see the permalinks in `src/`). Each deviation is also annotated at the code site.

| # | Where | Deviation | Reason |
|---|---|---|---|
| 1 | `src/codex.ts` (headers) | `originator: opencode`, no `User-Agent`/`version` headers | This plugin is not the codex client; it identifies itself the way OpenCode already does on the same backend |
| 2 | `src/codex.ts` (`withSizeNote`) | Appends `Output image size — width/height` to the prompt when `size` is `WIDTHxHEIGHT` | Codex has no size arg (its model writes dimensions into the prompt itself). The backend ignores the structured field and honors prompt dimensions (verified 2026-07-13 and 2026-09-10) |
| 3 | `src/index.ts` (tool args) | `out`, `size` and `images` exist; codex's tool has `referenced_image_paths` and `num_last_images_to_include` and no `quality` | `out` is where the plugin saves; `size` feeds deviation 2; `images` keeps the name existing users rely on; `num_last_images_to_include` needs conversation history the plugin API does not expose |
| 4 | `src/codex.ts` (turn id) | `x-codex-image-turn-id` carries the OpenCode `messageID` | Closest equivalent of a codex turn id; the backend accepts non-UUID values |
| 5 | `src/codex.ts` (HTTP errors) | Error body is raw text truncated to 500 chars; codex renders Rust's `Debug` form of `Option<String>` | Readability; the `Some("...")` formatting is a thiserror artifact, not a contract |
| 6 | `src/codex.ts` (429) | A 429 surfaces as a plain HTTP error; codex parses `usage_limit_reached` + `limit_id=image_gen` into a typed failure with `resets_at` | The plugin has no UI to render a typed failure; the response body already states the limit |
| 7 | `src/codex.ts` (response) | An empty-string `b64_json` is rejected as "no image data"; codex would accept it | Decoding an empty string would write a 0-byte PNG |
| 8 | `src/codex.ts` (retry) | Every fetch rejection is treated as a retryable transport error; codex retries only its `Timeout`/`Connection`/`Network` variants | fetch does not classify failures the way reqwest does; its rejections are all transport-shaped in practice |
| 9 | `src/codex.ts` (analytics) | `x-codex-imagegen-request-id` and `generation_id` are not recorded | Codex uses them only for analytics events the plugin has no sink for |
| 10 | `src/input-image.ts` | Paths may be relative (resolved against the OpenCode context dir); MIME comes from magic-byte sniffing via `file-type`; no re-encoding | Codex requires absolute paths and re-encodes non-PNG/JPEG/WebP inputs to PNG; a raster re-encoder is a heavy dependency for a plugin (known gap: GIF references are sent unconverted) |
| 11 | `src/output-image.ts` | Saves to the caller-specified path with non-overwriting `-vN` versioning; codex saves to `generated_images/{session}/{call_id}.png` | Output placement is this plugin's own behavior |
| 12 | `src/index.ts` (tool output) | Returns a text message + metadata; codex returns the image itself to the model | The OpenCode tool interface returns text only |
| 13 | `src/codex.ts` (test seam) | `retryBaseDelayMs` is injectable | Bun lacks reliable timer faking; the seam lets unit tests skip real backoff waits (same precedent as `pickNonOverwritePath`'s `maxVersion`) |

## Consequences

- Image generation keeps working after the backend drops the hosted tool, on the path codex itself exercises.
- `quality` disappears from the tool schema (a minor release, since the argument had no effect).
- Reference images are capped at 5 per call; more than that was never accepted by the new endpoint's client in codex.
- Future ports: diff codex against `c77c34ed` for `codex-rs/ext/image-generation/`, `codex-rs/codex-api/src/images.rs`, `codex-rs/codex-api/src/endpoint/images.rs`, `codex-rs/model-provider/src/bearer_auth_provider.rs` and `codex-rs/model-provider-info/src/lib.rs`, then update this ADR's reference commit and the permalinks in `src/`.

## Task list

- [x] Investigate codex at `c77c34ed` and verify the endpoint empirically
- [x] Write this ADR
- [ ] `src/codex.ts`: images endpoint call with retry, error layering, size note (TDD via `tests/unit/codex.test.ts`)
- [ ] `src/input-image.ts`: cap at 5 images, codex error wording
- [ ] `src/index.ts` / `src/types.ts`: schema (drop `quality`, `size` grammar, `images` max 5), turn id header
- [ ] `src/output-image.ts`: codex-style output hint in the versioned-save message
- [ ] Remove `eventsource-parser`
- [ ] README / AGENTS.md / package.json description
- [ ] `bun run typecheck`, `bunx biome ci .`, `bun run test`
- [ ] `bun run test:e2e_subscription`
- [ ] simplify + code-review loop until no findings
- [ ] Rewrite commits into reviewable units and force-push

## Public references

- [Introducing gpt-image-2 - available today in the API and Codex](https://community.openai.com/t/introducing-gpt-image-2-available-today-in-the-api-and-codex/1379479) (2026-04-21)
- [Introducing ChatGPT Images 2.0](https://openai.com/index/introducing-chatgpt-images-2-0/)
- [Image generation guide](https://developers.openai.com/api/docs/guides/image-generation). This documents the public API (`/v1/images/generations`); no official document describes the Codex backend images endpoint itself.
