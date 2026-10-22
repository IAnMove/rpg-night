# A three-minute RPG Night demo

Use `PROVIDER=demo` for a repeatable, zero-cost recording. State clearly that the seeded demo uses
authored text and procedural art. To show actual generated content, use the Local host backed by the
configured Ollama model; the live English probe generated and completed one story, but did not evaluate
its literary quality.
The full conversational evaluation has since generated and validated a story in each language; see [review evidence](review.md). Neither story was started automatically. Have a person review their narrative quality before presenting the generated prose. Use Bedrock only after verifying credentials and model access; do not describe fallback content as model output.

1. **0:00–0:20 — Hook.** “What if a game night became a comic of the story we made together?”
   Show the landing page and identify the local conversational host as a simulation, not an Echo.
2. **0:20–0:55 — Choose together.** Select Local host. Ask it to list adventures, choose one by name,
   and start for the named players. Narration comes from the actual public turn returned through MCP.
3. **0:55–1:20 — Choose together.** Click a numbered option in the host and point out that the canonical
   MCP result controls the next turn. The host real probe has reached an ending in both languages.
4. **1:20–1:50 — Shared room.** Click **Open shared screen**. Show that the current public turn and the
   already played panels follow the host over SSE. Browser mic input is optional and uses browser speech recognition.
5. **1:50–2:25 — Keepsake.** Download the host-mode public-history SVG and use Print → Save as PDF.
   Use the classic deterministic mode if a PNG export or repeatable illustrated comic is needed.
6. **2:30–2:55 — Architecture.** Ollama host, official MCP SDK, authoritative story engine, shared TV,
   and the optional Bedrock adapter. Be explicit that there is no published Alexa skill.

## Suggested submission description

RPG Night turns a living-room role-playing session into a keepsake comic. A local conversational host
uses Ollama and eight validated MCP tools to guide a party through authored English or Spanish
adventures and can prepare a short generated story; the server remains authoritative for choices, state, and dice. The browser can send typed
or recognized speech and shares only public turn snapshots with a companion screen and comic export.
New stories have been generated and validated in English and Spanish; the authored-story probe also reached its ending. This is a browser simulation, not a
published Alexa+ skill. Adventure generation is presented only if its MCP provider is implemented and
verified; otherwise, the host reports that the feature is unavailable.

## Final manual checklist

- [ ] Complete an adventure on a clean checkout.
- [ ] If claiming AWS Builder usage, demonstrate actual Bedrock generations with your account.
- [ ] Register/connect the MCP endpoint with the target Alexa+ host if available.
- [ ] Verify current track eligibility and rules on the official Devpost site.
- [ ] Publish/share the repository with reviewers as required.
- [ ] Record and upload a public video shorter than three minutes.
- [ ] Distinguish the browser simulation from a deployed Alexa skill.
- [ ] Provide firsthand feedback on Amazon/AWS tools actually used; do not invent feedback.
- [ ] Submit in Devpost and verify its submitted status.

## Development assistance

Codex/Luna implemented and reviewed the shared contract, game engine, MCP/HTTP services, host UI,
public second screen and comic, persistence, exports, deployment materials and automated tests. Grok's
CLI returned HTTP 402 when asked to make a correction, so Luna completed its assigned technical work.
Generated code is subject to the same TypeScript, integration and browser checks as the rest of the project.
