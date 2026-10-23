# Tests and verification

## Required checks

From the repository root, with Node.js 22.12 or later:

```sh
npm ci
npm run check
npm test
npm run build
```

Use `npm.cmd` on PowerShell if necessary. The deterministic suite uses isolated temporary data and
mock model/AWS transports; it does not require downloading a model or making paid AWS requests.

## Browser tests

```sh
npx playwright install chromium
npm run test:e2e
```

If Chrome is already installed, `PLAYWRIGHT_CHANNEL=chrome` can select it instead. On PowerShell:

```powershell
$env:PLAYWRIGHT_CHANNEL = 'chrome'
npm.cmd run test:e2e
```

Playwright starts an isolated server on port 3101. It checks the classic game and conversational
controller, shared screen, exports, mobile layout, restoration and stale responses. Conversational
browser tests mock the model-facing HTTP flow.

## Optional live model checks

Keep Ollama and the documented model running before opting in:

```sh
npm run probe:host:v2
npm run eval:host:v2
npm run probe:generation
```

These commands perform real local inference and can take time. The v2 host probe uses a separate
port and temporary game data. The evaluation checks 20 English/Spanish scenarios and observable
tool/state behavior. The older `probe:host` command targets the separate legacy API.
Generated text still needs human review.

## Coverage and observed results

As of October 23, 2026, the deterministic suite contains **90 passing tests**. It covers schema and
graph validation, bounded generated-story playability, engine conditions/effects, d20 checks,
persistence, idempotency, concurrency, HTTP/MCP, public projections, exports and conversational
recovery. The frontend/server production build and strict TypeScript checks pass.

The previously completed Chrome suite passed **8/8** scenarios. Real Ollama/MCP evaluation passed
**20/20** English/Spanish scenarios with the documented Qwen3 4B model. A separate LAN deployment
completed the authored Spanish adventure with Llama 3.2 3B, including a d20, public TV history and
the SVG comic. Numbered or exact-label choices execute via MCP without model inference.

Production was also exercised from a clean source copy, including installation, English/Spanish
endings, restart persistence and PNG/SVG/PDF exports. Exported PDF pages were rendered and inspected.
These results cover the tested examples, rather than arbitrary generated prose or every device.

## Limits of the evidence

- Real microphone capture, speaker quality and a physical TV need a human rehearsal. Speech e2e
  input is synthetic; text/button play does not certify a microphone.
- Small models can misinterpret open-ended requests or write contradictory stories. Mechanical
  validation does not prove literary consistency.
- Live Bedrock calls were not made; AWS adapter parsing/fallback uses a fake transport.
- Docker configuration was reviewed, but a running image was not verified.
- A server responding to its own LAN address does not establish another device's firewall access.

Keep local test data, transcripts, screenshots and generated files outside version control.
