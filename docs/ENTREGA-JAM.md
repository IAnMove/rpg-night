# RPG Night — submission and testing guide

Track: **Alexa+ — simulated browser experience**.
Repository: https://github.com/IAnMove/rpg-night
Implementation: [main](https://github.com/IAnMove/rpg-night/tree/main).
License: [MIT](../LICENSE).

The [official rules](https://amazonappdev2026.devpost.com/rules) and
[FAQ](https://amazonappdev2026.devpost.com/details/faqs) allow an Alexa+ simulation and local testing.
An Echo and a continuously hosted server are not required for this route. The submission deadline is
October 23, 2026 at 21:00 Europe/Madrid (12:00 PDT).

## Project description

RPG Night turns a cooperative game night into an illustrated story to keep. Players type, choose,
or use optional browser voice while a conversational Game Master guides them through an English or
Spanish adventure.

The browser simulates the intended Alexa+ experience. An Ollama-backed host discovers and calls
eight tools on a real MCP server over Streamable HTTP. The engine validates actions and owns the
choices, inventory, consequences and d20 rolls. Clear numbered or exact-label decisions execute
through MCP without another model inference; open-ended wording can prompt clarification.

Sessions persist across restarts. A read-only shared screen follows the same public story, and the
party can export an illustrated PNG/SVG comic or print it as PDF. The atmospheric art is original
procedural SVG. Optional story preparation generates a bounded adventure before the party explicitly
chooses to start it; generated prose needs editorial review.

This is a functioning browser simulation, rather than a published Echo skill. A separate classic
mode runs without an LLM. The demonstrated default flow does not use AWS services.

## How to test

Follow the [README quick start](../README.md#quick-start). Install Node.js 22.12+, npm and Ollama,
then install the documented model once:

```sh
git clone https://github.com/IAnMove/rpg-night.git
cd rpg-night
npm ci
ollama pull qwen3:4b-instruct-2507-q4_K_M
npm run dev
```

Keep the Ollama application or `ollama serve` running. Open http://localhost:3000, select EN, enter
Ada and Bo, and choose **Play with the local Game Master**.

1. Wait for the host to offer **The Bell Beneath Elderglen**.
2. Type **We choose The Bell Beneath Elderglen. Start it for Ada and Bo.**
3. Follow the offered decisions. **We choose option 1** is a reliable typed selection.
4. At a pending check, use **Roll the dice**. Do not supply a dice total.
5. Open the shared screen, reach an ending, and export the comic from that same game.
6. Reload to check restoration. Restarting the server preserves saved games in `data/`.

No API key or AWS account is needed. Text play is sufficient. Browser microphone support and HTTPS/
localhost restrictions are separate from the game logic. See [DEMO.md](DEMO.md) for a short walkthrough.

## Tool feedback — observed behavior

| Tool | Use and observed result | Friction or improvement opportunity |
| --- | --- | --- |
| Official MCP TypeScript SDK | Real Streamable HTTP client/server, protocol negotiation, tool discovery and eight runtime tools. | Revision checks, retries and recovery still need application logic. A small persistent-host recovery example would help. |
| Ollama and local models | Intent interpretation and structured adventure preparation. Authored games were exercised with Qwen3 4B and Llama 3.2 3B. | Cold loading and hardware affect latency. Small models can choose the wrong tool, omit fields or produce inconsistent prose; bounded validation and explicit choices are needed. |
| Alexa+ documentation and hackathon FAQ | Identified the documented simulation route. | Partner-only tooling access is easy to miss in individual guides. Link the restriction and a runnable simulation example directly from setup pages. |
| Browser Web Speech APIs | Optional recognition and narration with text/buttons retained. | Browser support, permissions and secure-context requirements vary. Actual microphone quality needs a human check. |
| TypeScript, Node.js, Express and Zod | Shared typed contracts, HTTP service, validation and local JSON persistence. | Types alone do not validate model output or saved files; explicit runtime checks are needed. |
| Vite, Playwright and Node test runner | Build/serve the frontend and check engine, HTTP/MCP, recovery and browser flows. | Browser tests do not certify physical voice or the literary quality of a generated story. |

Personal onboarding impressions and willingness to use each tool again must be supplied by the
entrant. Do not claim live Bedrock, Kiro, physical Alexa or native Fire TV use from an adapter or UI.

## Submission checklist

- [ ] Verify the repository and MIT license while signed out.
- [ ] Record a real, clearly labeled simulation in English, under three minutes.
- [ ] Publish the video on YouTube or Vimeo and verify its signed-out link.
- [ ] Enter the description, testing instructions, repository and video in Devpost.
- [ ] Add tool feedback and personal answers; select the Alexa+ track.
- [ ] Submit before the deadline and save the confirmation.

An accessible repository does not itself confirm a submitted Devpost entry or a published video.
