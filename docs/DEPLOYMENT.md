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
docker run --rm -p 3000:3000 -e HOST_MODE=disabled -v rpg-night-data:/app/data rpg-night
```

Open http://localhost:3000. For Bedrock, pass settings with `--env-file .env` and use an appropriate
runtime IAM role or secure credential mechanism. Do not bake credentials into the image.

This portable container example runs the classic game. The full conversational demo is simplest with
Node and Ollama running on the same machine or trusted private LAN. In a container, `127.0.0.1:11434`
means the container itself. Configure a reachable private IPv4 address for Ollama on the LAN and enable
`HOST_MODE=ollama`; `host.docker.internal` and public model URLs are not accepted by this adapter.
The final review could not execute Docker because Docker Desktop's Linux engine was not running.

## Ollama on another LAN computer

The application and model may run on separate computers. For example, RPG Night on `.104` and Ollama
on `.115`, put these settings in the application's ignored `.env` file and restart `npm start`:

```dotenv
HOST=0.0.0.0
PORT=3000
PUBLIC_ORIGIN=http://10.20.30.10:3000
HOST_MODE=ollama
OLLAMA_BASE_URL=http://10.20.30.20:11434
OLLAMA_MODEL=llama3.2:3b
PROVIDER=demo
DATA_DIR=./data
```

Use an installed model that supports tool calling. Verify `http://10.20.30.20:11434/api/tags` from the
application computer first; the example does not install a model. If Ollama is listening only on loopback,
configure its `OLLAMA_HOST` and firewall for the trusted LAN before restarting Ollama. Keep inference
off the public internet. The model URL is server configuration, never player input: only HTTP loopback
and RFC1918 private IPv4 origins are accepted, without credentials, paths, queries or fragments.
`RPG_MCP_URL` remains local to the application and derives from `PORT` when omitted.

No browser CORS change is needed: the browser sends text to RPG Night, and RPG Night calls Ollama.
Thinking output is disabled to keep the model focused on the response/tool call. A cold model can still
take time to load; warm it with a short conversation before recording. Text play works over LAN HTTP.

## Phone/controller and shared TV

For a trusted local network, set `HOST=0.0.0.0` and `PUBLIC_ORIGIN` to the exact address clients open,
for example `http://192.168.1.20:3000`. The default host/origin checks intentionally reject unknown hosts.
Open that address on the TV and use the copied session link on the controller.
Do not bind only to the LAN IP while leaving `RPG_MCP_URL` on loopback: that makes the internal host lose
its MCP connection. `HOST=0.0.0.0` keeps both addresses reachable. The host/origin check still accepts only
the configured name and loopback names. Restrict any firewall exception to the private local subnet.
If Windows denies adding a firewall rule, administrator access is required on that computer; a successful
request from the server to its own LAN IP does not prove another device can connect.
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
- **Host fails after a port change:** remove an obsolete `RPG_MCP_URL` override; by default it derives from `PORT`.
- **Host not allowed:** set `PUBLIC_ORIGIN` to the exact URL you open, then restart.
- **Bedrock warning:** check credentials, region, model access and inference-profile ID. The warning
  identifies text or image fallback. Logs include error names without credentials.
- **Mic unavailable:** try Chrome/Edge on localhost or HTTPS; type or use choices otherwise.
- **No narration:** turn narration on and check available browser voices and sound settings.
- **Second screen paused:** SSE reconnects automatically with the latest public session or host-conversation snapshot.
