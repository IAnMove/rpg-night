# RPG Night

**A cooperative adventure for the sofa — and a comic to keep.**

RPG Night is a browser simulation of an Alexa+ conversational Game Master. Players type, use optional
browser voice, or choose an offered action together. A local language model guides the conversation;
a real MCP game service owns the story state, inventory, choices and d20 results.

The same game can appear on a read-only shared screen and become an illustrated comic. The pictures
are original procedural SVG illustrations. This project demonstrates a web simulation; it does not
connect to an Echo or claim a published Alexa+ skill.

## Quick start

Requires **Node.js 22.12 or later**, npm, and Ollama for the conversational mode.

```sh
git clone https://github.com/IAnMove/rpg-night.git
cd rpg-night
npm ci
npm run dev
```

Open **http://localhost:3000**. The application is on `main`. No AWS account or API key is required
for the default demo.

For the conversational Game Master, install [Ollama](https://ollama.com/download), start its desktop
application (or run `ollama serve` in another terminal), and install the documented model once:

```sh
ollama pull qwen3:4b-instruct-2507-q4_K_M
```

The model download is approximately 2.5 GB. Installing npm packages or starting RPG Night does not
download models. On PowerShell, use `npm.cmd` if the execution policy blocks `npm.ps1`.

## Play the conversational demo

1. Select **EN**, enter synthetic player names such as **Ada, Bo**, and click **Play with the local
   Game Master**. The host offers the available adventures.
2. Type: **We choose The Bell Beneath Elderglen. Start it for Ada and Bo.**
3. Choose an offered action by clicking it, writing **We choose option 1**, or writing
   **We choose: [the exact option label]**. Clear numbered and exact-label choices go directly through
   MCP; other wording is interpreted by the model and may need clarification.
4. When a d20 check is pending, click **Roll d20** or type **Roll the dice**. The server rolls it once.
   Success and setback both continue the adventure.
5. Use **Open shared screen** to follow that same game in another tab. Reach an ending and export
   the illustrated PNG/SVG comic, or use **Print / Save PDF**.

English and Spanish are supported. Text is enough to try the complete flow. Microphone recognition
and spoken narration are optional, depend on browser support, and usually require HTTPS or localhost.
Keep Ollama running; a cold model can take time to load.

The landing page also includes a separate classic game that works without a model. For the Alexa+
simulation, use **Play with the local Game Master** and its own shared-screen/comic link.

## Configuration

The application works with defaults. To change them, copy `.env.example` to your local `.env`.
The latter is ignored by Git and should never be committed.

```dotenv
PROVIDER=demo
HOST_MODE=ollama
OLLAMA_BASE_URL=http://127.0.0.1:11434
OLLAMA_MODEL=qwen3:4b-instruct-2507-q4_K_M
PORT=3000
HOST=127.0.0.1
DATA_DIR=./data
```

An installed tool-capable model such as `llama3.2:3b` can be selected with `OLLAMA_MODEL`. Model behavior
and speed vary. Ollama may also run on a trusted LAN computer: replace loopback in `OLLAMA_BASE_URL`
with that computer's private IPv4 address. The browser sends requests only to RPG Night; the server
calls Ollama. No browser CORS change is needed.

The internal `RPG_MCP_URL` defaults to `http://127.0.0.1:<PORT>/mcp` and stays loopback-only. See
[deployment instructions](docs/DEPLOYMENT.md) for LAN access, Docker and HTTPS.

## How it works

```text
Player text / optional browser speech
                 |
          Conversational host + Ollama
                 |
          Official MCP TypeScript client
                 |
          MCP game service /mcp
                 |
          Validated engine + persistent JSON
                 |
          Public story -> shared screen -> comic
```

The model proposes intentions; the server checks them against the current public turn. It cannot
authorize invented items, future story nodes, chosen dice totals or arbitrary effects. Request IDs
and revisions protect against duplicate retries and stale controllers. Saved sessions survive
server restarts in `data/`. Pause and resume are conversation controls.

The server exposes eight tools over **Streamable HTTP**, with MCP protocol **2025-11-25** support:

| Tool | Purpose |
| --- | --- |
| `list_adventures` | Offer public adventure summaries. |
| `prepare_adventure` | Queue a new locally generated adventure for validation. |
| `get_operation_status` | Poll preparation: pending, ready or failed. |
| `start_session` | Start the adventure explicitly selected by the party. |
| `get_session` | Read the latest public turn. |
| `submit_action` | Validate and apply one player action. |
| `resolve_check` | Resolve the pending server-side d20 check. |
| `end_session` | Close the current game safely. |

Prepared adventures pass schema, graph and bounded mechanical-playability checks before being
offered. Preparation is asynchronous and can fail safely. A generated story still needs human
editorial review; the authored adventure is the recommended first demo.

```json
{ "mcpServers": { "rpg-night": { "url": "http://localhost:3000/mcp" } } }
```

MCP host configuration varies. The separate `/mcp/legacy` endpoint supports the classic mode and
should not be used for the conversational v2 flow.

## Verify and run production

```sh
npm ci
npm run check
npm test
npm run build
npm start
```

`npm start` serves the compiled application on port 3000. The server is intended for a trusted living
room, one process and persistent local storage. It has no accounts, pairing, OAuth or per-user quotas.
Treat shared game links as access links. Add appropriate authentication and rate limits before an
internet deployment.

An optional Bedrock adapter is included in the classic game. It requires your own AWS credentials,
model access and configuration, and calls can incur charges. The default demo makes no AWS calls;
the included adapter is not evidence of a live AWS integration.

## Documentation

- [Demo walkthrough](docs/DEMO.md)
- [Submission and testing guide](docs/ENTREGA-JAM.md)
- [Deployment](docs/DEPLOYMENT.md)
- [Tests and coverage](docs/TESTING.md)
- [Architecture](docs/architecture.md)
- [MCP and host API contract](docs/mcp-contract.md)
- [Reference adventure](docs/reference-adventure.md)

Built for the **Alexa+ track** of [Build, Ship, Shape: Amazon Developer Hackathon](https://amazonappdev2026.devpost.com/).
The demonstrated experience is a browser simulation. See the
[official rules](https://amazonappdev2026.devpost.com/rules).

## License

[MIT License](LICENSE) — Copyright © 2026 IAnMove.
