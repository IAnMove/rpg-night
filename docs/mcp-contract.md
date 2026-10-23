# MCP and conversational host contract

Executable schemas in `shared/session-schema.ts` and `shared/host-schema.ts` define the API.
Public results are validated before serialization. The canonical endpoint is `/mcp` over
Streamable HTTP, using the official TypeScript SDK with MCP protocol 2025-11-25 support.

## Tools

| Tool | Input / result |
| --- | --- |
| `list_adventures` | Locale and optional filters -> public adventure summaries; no graph or hidden facts. |
| `prepare_adventure` | Request ID, premise, locale, bounded preferences -> preparation operation. |
| `get_operation_status` | Operation ID -> pending, ready or failed; ready exposes an adventure summary. |
| `start_session` | Request ID, selected adventure, locale and player names -> first public turn. |
| `get_session` | Bound session ID -> current public turn without advancing it. |
| `submit_action` | Session, expected revision, request ID and discriminated interaction -> validated action result. |
| `resolve_check` | Session, current check ID, expected revision and request ID -> server-rolled result. |
| `end_session` | Session, revision and request ID -> closed game at the actual current scene. |

A `choice` interaction uses a currently offered choice ID. A `free_action` uses a current affordance
ID and only its allowed target, approach and owned item IDs. The model supplies no arbitrary effects,
destination nodes, invented inventory or chosen dice totals. Only a pending check can be rolled.

The host derives session/revision/request linkage and validates player intent. Selecting an adventure
does not authorize another preparation. A pending or ready generated story never starts until chosen.

## Public state and consistency

A `PublicTurn` contains schema/locale metadata, revisions, the revealed scene, currently enabled
choices/affordances, revealed inventory, a pending check or resolved outcome, recap and phase.
It excludes the complete template, future nodes, private variables and hidden story facts.

A mutating retry with the same request ID and input fingerprint returns its stored result before
revision comparison. Reusing a key with different input fails. A new stale command returns a revision
conflict without applying another action. The controller refreshes before the next decision.

Game phases include `awaiting_choice`, `awaiting_check` and `ended`. Preparation has its own durable
operation lifecycle. Conversation pause/resume does not itself increment the engine revision.
An early explicit close is distinct from reaching an authored ending.

## Host HTTP routes

- `POST /api/host/conversations` creates or idempotently returns a conversation.
- `GET /api/host/conversations/:id` restores it without another create fingerprint.
- `POST /api/host/conversations/:id/turns` accepts player text and optional expected revision.
- `POST /api/host/conversations/:id/pause` and `/resume` control the conversation.
- `GET /api/host/conversations/:id/operation` reads only its linked preparation.
- `GET /api/host/conversations/:id/tv` returns the public shared-screen snapshot.
- `GET /api/host/conversations/:id/events` streams public snapshots over SSE.
- `GET /api/host/conversations/:id/art/:revision.svg` renders atmosphere for an already public revision.
- `GET /api/host/conversations/:id/comic.svg` exports the played public history.

The browser can convert that self-contained SVG to PNG and print the shared screen as PDF.
Comic panels group consecutive snapshots of the same revealed scene. Public histories are bounded.

## Configuration and boundaries

`HOST_MODE=ollama` enables the conversational host. `HOST_MODE=disabled` leaves the classic game
available while host routes report unavailable. `RPG_MCP_URL` must use loopback HTTP and the canonical
`/mcp` path; by default it derives from `PORT`.

`OLLAMA_BASE_URL` accepts HTTP loopback or a configured RFC1918 private IPv4 origin, without
credentials, paths, query or fragment. Thinking output is disabled in model requests. Player input
cannot select a model endpoint. The host has tool/round/time bounds and propagates disconnection
cancellation. No account-level authorization or public-service quotas are implemented.
