# Verification

```sh
npm ci
npm test
npm run build
```

Server tests run with Node's test runner and isolated temporary data directories. They cover every
world/language, normal and early endings, dice consumption, inventory consequences, concurrent stale
choices, saved-session recovery, validation, XML escaping, HTTP routes, SSE cleanup and the official MCP
client making real Streamable HTTP calls. AWS response parsing/fallback is tested using a fake transport;
no test incurs AWS charges.

The deterministic suite covers the game engine, persistence, MCP protocol, local host orchestration,
security boundaries, HTTP routes and browser behavior, including delayed-response ordering between two
screens and simulated voice recognition/narration. Simulated speech verifies application behavior;
real microphone capture and browser voice availability remain hardware checks below.

## Local LLM feasibility probe

With Ollama running and `qwen3:4b-instruct-2507-q4_K_M` already installed, three opt-in checks use real
local inference:

```powershell
npm.cmd run probe:host       # historical v1 tools, isolated synthetic game
npm.cmd run probe:host:v2    # current browser host → Ollama → canonical MCP path
npm.cmd run probe:generation # local Ollama → prepare/poll/list/start/play-to-ending via canonical MCP
npm.cmd run eval:host:v2     # 20 conversational checks (10 per language) over real local Ollama/MCP
```

The v2 probe binds port 3102 by default (override with `HOST_LIVE_PORT`), uses a temporary data
directory, and writes a summary without player transcripts to `.work/host-live/`. It also completes one
authored adventure per language and checks the real public TV snapshot, first SSE event, and SVG export.
It does not touch the game on port 3000, download models, or call a paid inference API. Failed checks
return a nonzero exit code. The v1 result is historical; it uses the old tools on `/mcp/legacy` and does
not validate the new host contract. Narration fidelity still requires human review. See [initial probe
evidence](feasibility.md) and the [current host v2 report](host-v2-check.md).

The generation probe binds port 3103 by default (override with `GENERATION_LIVE_PORT`), uses a temporary
data directory, and writes only the model, generated adventure title/ID, operation status, final revision
and elapsed time to `.work/generation-live/`. It does not save the story to the repository or touch the app
on port 3000. The current English run generated, validated, listed, started and played a story to its
ending; earlier attempts exposed model/schema mismatches and motivated a conservative fallback for omitted
choice action text. See [live generation result](generation-live-check.md). Spanish generation was also
verified in the conversational evaluation described below.

The conversational evaluation uses the configured local Ollama model, an isolated data directory and a
temporary host port (3104 by default; override with `HOST_EVAL_PORT`). It runs ten behavioral scenarios in
English and repeats them in Spanish, including a newly generated story in each language. It writes a
summary report to ignored `.work/review/` without conversation transcripts, premises, player names or free-form
model responses. It does not touch the game on port 3000 or call a paid model API. The run can take a few
minutes because story generation is real. The latest result and limits are recorded in [review](review.md).

## Latest verification

On 22 October 2026, `npm.cmd test` passed **88/88**, `npm.cmd run build` completed, and
`PLAYWRIGHT_CHANNEL=chrome npm.cmd run test:e2e` passed **8/8** using the installed Chrome. The live
Ollama/MCP conversational matrix passed **20/20** across English and Spanish. Automated assertions cover
tool execution, state and privacy invariants; a person still needs to review narrative quality and test a
real microphone. See the [review report](review.md) and [shared-screen probe](host-v2-check.md).

## Browser tests

```sh
npx playwright install chromium
npm run build
npm run test:e2e
```

On a machine with Chrome already installed you can use `PLAYWRIGHT_CHANNEL=chrome` instead of downloading
Chromium. In PowerShell: `$env:PLAYWRIGHT_CHANNEL='chrome'; npm run test:e2e`.
The suite starts the **production build** on port 3101, stores its sessions in ignored
`.work/browser-data`, and exercises the actual UI. Failed runs retain a Playwright trace.

The final review also installed a clean source snapshot using `npm ci --offline`, compiled it and ran
the compiled host with real Ollama/MCP on port 3110. It completed an English authored story and a newly
generated Spanish one, downloaded/decoded PNG, checked self-contained SVG, printed PDF, and compared
the entire public state after a process restart. PDF extraction checked every played narration; all
nine rendered pages were visually reviewed. These local artifacts are in ignored `.work/final-review`.
The host-specific browser suite was also rerun after the saved-conversation recovery change (4/4).

Generation validation checks mechanical playability of every reachable state and both d20 outcomes,
not literary consistency. The review found a narrative contradiction and strengthened the prompt;
generated prose still needs editorial review. See [the findings](review.md).

Manual checks that require hardware, permissions or accounts:

- Allow the microphone in a supporting browser and speak one action in each language.
- Enable narration, mute it, change chapters and ensure narration does not repeat on dice updates.
- Use full screen on the intended TV and check readability from the sofa.
- Verify the browser's print dialog saves the entire comic as PDF.
- If demonstrating Bedrock, use valid AWS credentials and confirm both models work in your region.
- If partner access to an Alexa+ host is available, test its HTTPS integration separately. The browser simulation is the documented submission path and needs no Echo connection.
