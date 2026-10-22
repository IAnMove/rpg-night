# Running on a TV or server

## Production build

```sh
npm ci
npm run build
npm start
```

Run commands from the repository root. `PORT` defaults to 3000. `DATA_DIR` defaults to `./data`
and must be writable and persistent. Back up that directory to preserve sessions and generated images.
Each JSON write uses an atomic rename. Run **one Node process** against a data directory: the in-memory
session index and SSE bus are process-local. This MVP is not a multi-tenant or horizontally scaled service.

## Docker

```sh
docker build -t rpg-night .
docker run --rm -p 3000:3000 -v rpg-night-data:/app/data rpg-night
```

Open http://localhost:3000. For Bedrock, pass settings with `--env-file .env` and use an appropriate
runtime IAM role or secure credential mechanism. Do not bake credentials into the image.

## Phone/controller and shared TV

For a trusted local network, set `HOST=0.0.0.0` and `PUBLIC_ORIGIN` to the exact address clients open,
for example `http://192.168.1.20:3000`. The default host/origin checks intentionally reject unknown hosts.
Open that address on the TV and use the copied session link on the controller.
There is no account or pairing system: a session UUID or host conversation UUID is a capability. Anyone
with a classic session URL can view and control that game; anyone with a host TV URL can view its public
turn history and comic export. Anyone who can reach the service can create a new session.

Browser microphone recognition usually requires HTTPS or localhost and is browser-dependent. A Fire TV
browser may have no speech API; use a supporting desktop/phone as controller or an MCP host. Typed input
and choice buttons remain available. Browser recognition can use the browser vendor's cloud service;
there is no application-side microphone recording or audio upload.

## Remote MCP host / HTTPS

Use a reverse proxy or host with HTTPS, persistent disk and support for long-lived SSE connections
(disable response buffering for `/api/sessions/*/events` and `/api/host/conversations/*/events`). Set
`PUBLIC_ORIGIN` to the public HTTPS origin.
Keep `/mcp` and the web companion on the same application.

Before exposing this publicly, add authentication/authorization and rate limits at the proxy or host,
especially in Bedrock mode. A publicly reachable unauthenticated endpoint can initiate paid generations.
The local demo has host/origin checks and bounded input, but no OAuth or per-user quota system.
An Alexa+ host may impose its own OAuth, registration and deployment requirements; verify those in its
current developer documentation. No Alexa+ account is configured by this repository.

## Troubleshooting

- **Blank page:** run `npm run build` before `npm start`, or use `npm run dev`.
- **Port in use:** stop the earlier server or change `PORT`.
- **Host not allowed:** set `PUBLIC_ORIGIN` to the exact URL you open, then restart.
- **Bedrock warning:** check credentials, region, model access and inference-profile ID. The warning
  identifies text or image fallback. Logs include error names without credentials.
- **Mic unavailable:** try Chrome/Edge on localhost or HTTPS; type or use choices otherwise.
- **No narration:** turn narration on and check available browser voices and sound settings.
- **Second screen paused:** SSE reconnects automatically with the latest public session or host-conversation snapshot.
