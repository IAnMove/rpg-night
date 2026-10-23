# RPG Night — short demo walkthrough

Target length: **2:45–2:50**. Show the functioning **Alexa+ browser simulation**, using text.
Use one conversational session for the controller, shared screen and comic.

## Prepare

1. Follow the README from `main`. Start Ollama and RPG Night.
2. Record the browser at 1920×1080 on `http://localhost:3000`. Hide notifications and personal data.
3. Select EN, enter **Ada, Bo**, and open **Play with the local Game Master**.
4. Rehearse the authored adventure. Keep the actual d20 outcome, whether success or setback.
5. Warm the model before recording. If you edit out loading time, visibly label the cut.
6. Text is enough; enable microphone/narration only if checked on the recording computer.

## Screen plan

| Time | Show | Suggested English voiceover |
| --- | --- | --- |
| 0:00–0:15 | Landing and the label “Alexa+ browser simulation”. | “What if your next game night started with a conversation and ended with a comic?” |
| 0:15–0:40 | Open the conversational host, show the offered adventure, and type the explicit selection. | “RPG Night is a cooperative adventure guided by a conversational Game Master. This demo runs in the browser, using a local model and a real MCP server.” |
| 0:40–1:10 | Type one offered choice and show the changed scene. Advance the rehearsed route. | “The players decide together. The game service validates their choice and saves the result. The language model interprets conversation; the engine owns the rules.” |
| 1:10–1:35 | Select the lever challenge, show the pending d20, roll, then keep the real result visible. | “Risky actions create a pending check. The server rolls the die once, and either outcome keeps the story moving.” |
| 1:35–1:55 | Show the shared screen from this same session, then make the final decision. | “Everyone can follow the same public story on a shared screen, without seeing future scenes.” |
| 1:55–2:15 | Show the authored ending and export the comic. | “At the end, the group keeps its choices and ending as an illustrated comic. The atmospheric artwork is procedural SVG.” |
| 2:15–2:35 | Reload the controller; show restoration and a simple architecture diagram. | “The game survives a reload. Behind it are an Ollama host, the official MCP TypeScript SDK, a validated engine, and persistent local storage.” |
| 2:35–2:50 | Show the repository README and MIT license. | “RPG Night runs locally in English and Spanish. Try the Alexa+ browser simulation from the open-source repository.” |

## Rehearsed English route

After the host offers the title, type **We choose The Bell Beneath Elderglen. Start it for Ada and Bo.**
Choose the following visible labels, by button or **We choose: [label]**:

1. Go to the village green.
2. Ask Elin what the villagers need.
3. Carry the drawing to the tower stairs.
4. Test the stiff release lever.
5. When a check is pending, type **Roll the dice**.
6. Ring the bell and warn the village.

Use the labels actually displayed. Both d20 outcomes on this route reach the spillway decision; do
not re-roll to manufacture success. Reload the same game to show persistence.

## Capture and submission

OBS or a screen recorder can capture the browser and an English explanatory voiceover. Keep text
legible. Export at 1080p, check the final runtime, and upload publicly to YouTube/Vimeo.
Test the video URL while signed out. See [submission guide](ENTREGA-JAM.md).

Optional generation is outside this short recording plan. If shown separately, record an actual
preparation and review the resulting prose. Clearly mark any edited waiting time. Do not show the
classic game's comic as though it belongs to the conversational session.
