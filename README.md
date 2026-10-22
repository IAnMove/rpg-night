# RPG Night

**Your next great story starts on the sofa.**

A cooperative role-playing game for a shared screen. The classic web mode includes a companion TV
and comic; a separate browser host demonstrates the conversational MCP architecture intended for
an Alexa+ compatible host. The local browser host is a simulation, not an Alexa integration.

## Run locally

Requires **Node.js 22.12 or later** and npm. No API key, AWS account or cloud service is needed for the demo.

```sh
git clone --branch codex/complete-mvp https://github.com/IAnMove/rpg-night.git
cd rpg-night
npm ci
npm run dev
```

Open **http://localhost:3000**. The classic deterministic demo needs no model. For the voice-led
Game Master, install Ollama and have the configured model available locally, then choose **Local host**.
That flow sends text or browser speech recognition to the server-side host, which uses Ollama and the
official MCP client to read and update the adventure. Authored adventures and host conversations support
English and Spanish; local story preparation is available in both languages. Microphone access and spoken
narration are optional browser features.

The implementation is currently on **`codex/complete-mvp`**; `main` still contains the original scaffold.
The repository is private, so cloning requires an authorized GitHub account until access is changed.
Use the [implementation branch](https://github.com/IAnMove/rpg-night/tree/codex/complete-mvp) for judging.
On PowerShell, use `npm.cmd` if the execution policy blocks `npm.ps1`.

For the conversational mode, install [Ollama](https://ollama.com/download), start its desktop app
(or run `ollama serve` in a separate terminal), and install the model once:

```sh
ollama pull qwen3:4b-instruct-2507-q4_K_M
```

This downloads a roughly 2.5 GB local model. No model download happens as part of `npm ci` or startup.

- A safe choice earns trust or an ally. A risky choice uses a d20 against **DC 11**.
- Roll first to prepare a check, or let the risky choice roll automatically. Each roll is consumed once.
- A demo adventure runs for six illustrated chapters, including its ending; generative adventures cap at eight.
- Finish early with **End adventure**, or play through the final chapter.
- Open **Comic** to download PNG/SVG or use Print → Save as PDF.
- In the classic game, copy the TV link into another browser tab. Both screens update together over SSE.
- Reload to resume. Sessions and generated images survive server restarts in `data/`.

**The classic demo mode is intentionally local and deterministic.** Its stories are authored, not
LLM-generated; illustrations are original procedural SVGs that vary with world, chapter and choice.
The separate voice-led mode uses a local LLM to interpret player intent, but game state, choices,
checks and effects remain authoritative in the MCP game service. It can prepare a compact new adventure;
the generated story is validated before it appears in the catalogue. No remote fonts, stock-image
services or external runtime assets are needed for the default demo.

## Local conversational host

The voice-led screen is a local simulation of a conversational host. It is **not an Alexa skill**,
does not connect to an Echo, and does not claim certification or a published Alexa+ integration.
It uses the following defaults (override in `.env`):

```dotenv
HOST_MODE=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3:4b-instruct-2507-q4_K_M
RPG_MCP_URL=http://127.0.0.1:3000/mcp
```

Ollama and the model must already be installed locally; `npm run dev` never downloads them. Set
`HOST_MODE=disabled` to turn off the conversation panel while retaining the deterministic game and
MCP service. The server-side host discovers tools with `tools/list` and calls the canonical MCP
endpoint through the official TypeScript SDK. See [presentation](presentacion.md), the
[execution plan](plan-ejecucion.md), and [current feasibility and evidence](docs/feasibility.md).

Ollama can also run on another trusted computer in your home network. Set `OLLAMA_BASE_URL` to its
private IPv4 origin (for example `http://10.20.30.20:11434`) and `OLLAMA_MODEL` to an installed model
that supports tools, then restart RPG Night. The browser talks only to RPG Night; the server calls
Ollama. Model endpoints accept loopback or private IPv4 HTTP addresses; the internal `RPG_MCP_URL`
remains loopback-only. Thinking output is disabled for interactive responses. See
[deployment](docs/DEPLOYMENT.md#ollama-on-another-lan-computer) for the complete configuration.

In Local host mode, **Open shared screen** opens a read-only view of the current public turn and played
story panels. Controller, TV and SVG comic share original procedural atmospheric illustrations derived
only from already public scenes. These are not model-generated images or extra story facts. The screen
follows updates over SSE and can download an illustrated PNG/SVG comic or print it as PDF. The classic
game's TV/comic is a separate legacy flow; the host screen never reads its private transcript or future
story nodes. This read-only snapshot, SSE event, and SVG export were also exercised against the real local
Ollama/MCP host in completed English and Spanish games. Treat a host conversation link like a bearer link:
anyone with it can see that public story.

## Amazon Bedrock mode

Copy `.env.example` to `.env` (`Copy-Item .env.example .env` in PowerShell) and set:

```dotenv
PROVIDER=bedrock
AWS_REGION=us-east-1
TEXT_MODEL_ID=amazon.nova-lite-v1:0
IMAGE_MODEL_ID=amazon.nova-canvas-v1:0
```

Use the AWS SDK's standard credential chain: an AWS profile/SSO session, an IAM role, or environment
credentials. Do not commit keys. The role needs `bedrock:InvokeModel` for the selected model or inference
profile. Model availability and access depend on account and region; `TEXT_MODEL_ID` may be an inference
profile ID/ARN when the model requires one. Images support **Nova Canvas** and **Titan Image Generator**.

Bedrock text uses the [Converse API](https://docs.aws.amazon.com/bedrock/latest/userguide/conversation-inference-call.html).
Illustrations use [Nova Canvas's native image API](https://docs.aws.amazon.com/nova/latest/userguide/code-examples-image.html).
Each new chapter requests text and one image. Requests incur AWS charges. Existing chapters are reused.
If either request fails, a visible warning identifies the local demo fallback; the session remains playable.
The default demo makes **no AWS calls**. Live AWS generation has to be verified with your own credentials.

## MCP / Alexa+ host

Canonical endpoint: **`http://localhost:3000/mcp`**, Streamable HTTP, official TypeScript SDK.
Protocol **2025-11-25** is supported. Requests are stateless; game state is identified by `session_id`.
The earlier demo protocol is retained separately at `/mcp/legacy`.

| Tool | Input | Result |
| --- | --- | --- |
| `list_adventures` | Locale and optional genre, player count, duration | Public authored adventure summaries |
| `prepare_adventure` | Premise, locale, preferences, request ID | Queued local Ollama generation; output is schema/graph validated with at most one repair before it is offered |
| `get_operation_status` | Operation ID | Read pending, ready or failed preparation state |
| `start_session` | Adventure ID, locale, players, request ID | First validated public turn |
| `get_session` | Session ID | Latest public turn without mutation |
| `submit_action` | Session ID, revision, request ID, typed interaction | One validated action or recoverable result |
| `resolve_check` | Session ID, check ID, revision, request ID | Server-side random check and public result |
| `end_session` | Session ID, revision, request ID | Closes the current session safely |

The legacy endpoint exposes the five earlier demo tools. Do not configure a host against it for the
voice-led v2 flow. See [MCP contract and host routes](docs/mcp-contract.md).

Generated adventures use the configured local Ollama model and are saved under `DATA_DIR/generated-adventures`.
Preparation is asynchronous; the local host polls its conversation-bound operation and never starts a story
without an explicit player choice. Real generation and the full 20-scenario host evaluation have passed in
English and Spanish; narrative quality still needs human review. `OLLAMA_GENERATION_TIMEOUT_MS` defaults to
120 seconds per generation attempt (a single repair may use another attempt); the durable operation expires
after five minutes. See [generation verification](docs/generation-live-check.md) and the [review report](docs/review.md).

```json
{ "mcpServers": { "rpg-night": { "url": "http://localhost:3000/mcp" } } }
```

Configuration varies by MCP host. This repository does not claim a published Alexa skill or a certified
Alexa+ integration. Connecting from a remote host requires a reachable **HTTPS** deployment and that
host's registration/access process. See [deployment notes](docs/DEPLOYMENT.md).

## Commands and verification

```sh
npm run dev        # One server: API, MCP, SSE and Vite frontend
npm run check      # Strict TypeScript check
npm test           # Game, persistence, HTTP, SSE and real MCP client integration
npm run build     # Production frontend and compiled Node server
npm start         # Serve the production build
npm run eval:host:v2 # Opt-in: 20 real Ollama/MCP host scenarios in English and Spanish
```

Browser tests and their setup are described in [testing notes](docs/TESTING.md).

## Architecture

```text
Browser speech / text → HTTP → Ollama host → official MCP client → MCP game service
                                                       │
                                    Atomic JSON state + public turn projection
                                                       │
                            Classic UI / SSE TV / comic PNG, SVG and print-PDF
```

`mcp-server/` contains the game, validated HTTP/MCP endpoints, providers and exports.
`web-tv/` is the TypeScript screen and voice client. `shared/` defines their data contract.
The per-session queue rejects stale choices and prevents simultaneous screens from duplicating a chapter.
The demo is designed for a trusted living room, with loopback binding and same-origin checks by default.
Changing `PORT` also changes the host's default loopback MCP endpoint. For a LAN demo, bind
`HOST=0.0.0.0` and set `PUBLIC_ORIGIN` to the exact LAN URL; keep loopback reachable for the internal MCP
client. Typed input and buttons work over LAN HTTP; microphone recognition needs HTTPS or localhost.

## Hackathon

Originally scoped for **Build, Ship, Shape: Amazon Developer Hackathon**, Alexa+ track and optional
AWS Builder mini-challenge. See [demo and submission materials](docs/DEMO.md) and the
[original brief](docs/BRIEF_FOR_AGENT.md). Verify current eligibility against the
[official rules](https://amazonappdev2026.devpost.com/rules) before submitting.
Publishing the repository, recording a video, configuring an Alexa+ host and submitting on Devpost are
separate steps; this code does not perform those actions.

See the [final review plan](docs/PLAN-REVISION-FINAL.md) and [submission checklist](docs/ENTREGA-JAM.md)
for verified evidence and the remaining recording/access/submission steps.

MIT licensed. Built with Codex and Grok; all executable changes are reviewed and tested locally.
