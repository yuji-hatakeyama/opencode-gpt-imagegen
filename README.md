# opencode-gpt-imagegen

> Bring **GPT image generation** to [OpenCode](https://opencode.ai). Use it through your **ChatGPT subscription** (no API costs!) or through the **OpenAI API** — your call.

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![status](https://img.shields.io/badge/status-v0.1.0-orange.svg)](#roadmap)

| Auth path | Status | Billing |
|---|---|---|
| **ChatGPT subscription** (OAuth) | **Available now in v0.1.0** | **No extra cost** — comes out of your existing Plus / Pro / Business plan |
| **OpenAI API key** | **Coming soon in v0.2.0** | Pay-per-image against your API credits, with `generate` + `edit` support |

## Highlights

- **Subscription-friendly.** Generations ride on the same Codex backend channel OpenCode already uses for ChatGPT subscription chat — billed against your ChatGPT plan, not your API credits.
- **Reference images.** Pass any number of input images alongside the prompt for style guidance, edit targets, or compositing inputs.

## Installation

*Installation instructions are coming with the upcoming npm release. Stay tuned.*

## Usage

Just ask your agent in natural language:

> Generate a beautiful 1024x1024 sunset image!

The agent picks `gpt_image_gen`, the plugin streams the generation, and the PNG lands on disk in your project directory.

## Roadmap

| Version | Auth path | Scope | Status |
|---|---|---|---|
| **v0.1.0** | ChatGPT subscription | `gpt_image_gen` with optional reference images (generation + reference-guided edits via prompting) | **Released** |
| **v0.2.0** | OpenAI API key | Adds the API-key billing path: both `generate` (`/v1/images/generations`) and `edit` (`/v1/images/edits`) with reference images | Next |
| **v0.3.0** | OpenAI API key | Adds **pixel-precise mask inpainting** via `/v1/images/edits` (binary PNG alpha mask) | Planned |

## How it works

OpenCode already talks to the OpenAI Codex backend to power ChatGPT subscription chat. This plugin reuses that same endpoint, attaching the hosted `image_generation` tool to a single-turn request, then writes the returned PNG to disk. Auth is read from OpenCode's standard `auth.json`; no new credential surface is introduced.

## Disclaimer

This is an **unofficial, third-party** plugin, not affiliated with or endorsed by OpenAI or OpenCode.

It uses the same Codex backend endpoint OpenCode itself calls for ChatGPT subscription chat — this plugin just adds the hosted `image_generation` tool to that conversation. Use must comply with OpenAI's [Terms of Use](https://openai.com/policies/row-terms-of-use/) and [Usage Policies](https://openai.com/policies/usage-policies/).
