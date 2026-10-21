# RPG Night — Alexa+ Game Master with a living TV comic

Hackathon: **Build, Ship, Shape: Amazon Developer Hackathon** (Devpost)
- Site: https://amazonappdev2026.devpost.com/
- Rules: https://amazonappdev2026.devpost.com/rules
- FAQ: https://amazonappdev2026.devpost.com/details/faqs
- **Deadline: Friday Oct 23, 2026, 12:00 PM PT (21:00 Madrid)**. Submit early, you can keep editing until the deadline.

## The idea
A group sits on the sofa. Alexa+ is the Game Master: it narrates a short role-playing adventure,
players decide out loud, dice are rolled, and **every decision becomes a generated illustration on the TV**.
At the end, the session is assembled into a **comic** of the game you just played together.

What exists today: voice adventures on Alexa (audio only, fixed script) and text AI RPGs (AI Dungeon).
What's new here: a *shared living-room* experience, voice-driven, generative story + generative images on the big screen, ending in a keepsake comic.

## Track
- Primary: **Alexa+** — a self-hosted **MCP server** (MCP spec >= 2025-11-25). Rules allow simulating the Alexa+ experience in a web app with our own agentic tools.
- Mini challenge: **AWS Builder** — use Amazon Bedrock (text + image) and/or build with Kiro, and document it.
- Optional stretch: Fire TV app (the web TV opened in Fire TV's browser is enough for the demo).

## Architecture
```
voice (browser mic / MCP client simulating Alexa+)
        │
        ▼
mcp-server/  ── tools: start_adventure, player_action, roll_dice, get_scene, end_session
        │        state: story, characters, inventory, scene list
        ├── LLM (Bedrock) writes next scene + choices
        ├── image model (Bedrock) illustrates the scene
        ▼
web-tv/  ── full-screen page: scene image, narration text, choices, dice, players
            final screen: comic (panels + captions), downloadable PNG/PDF
```

## MVP (must have by deadline)
1. MCP server with the 5 tools above, session state in memory/JSON.
2. Scene generation (text) + one image per scene.
3. Web TV page that updates live (SSE or WebSocket) when a new scene arrives.
4. Voice input in the browser (Web Speech API) calling the MCP tools; TTS narration.
5. End-of-session comic page (4–8 panels).
6. English by default; Spanish works too (bonus).

## Submission checklist (Devpost)
- [ ] Repo: public with an open-source LICENSE (MIT included) **or** private shared with testing@devpost.com and the Amazon reviewers listed on Devpost updates.
- [ ] Demo video < 3 min on YouTube/Vimeo, public, showing it running.
- [ ] Setup/run instructions in this README.
- [ ] Feature description, track + mini-challenge selection.
- [ ] Product feedback for every Amazon/AWS tool used (required field).
- [ ] Hit Submit and confirm status "Submitted".

## Demo video plan (< 3 min)
1. 0:00 hook: "Tonight, Alexa is our Game Master."
2. Friends pick a world; first scene appears on the TV.
3. Two or three decisions + a dice roll, images appear live.
4. Ending: the comic of the night on screen.
5. 15 s of architecture (MCP + Bedrock).

See `docs/` for details.
