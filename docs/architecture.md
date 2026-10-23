# Architecture

RPG Night separates conversation, authoritative game rules and public presentation.

```text
Browser text / optional speech
              |
Conversational host + Ollama
              |
Official MCP client -> Streamable HTTP /mcp
              |
Game engine + versioned JSON storage
              |
Public turn -> SSE shared screen -> comic export
```

The host discovers and calls the actual MCP tools. It supplies the bound session, revision and
request ID instead of trusting model-invented linkage. Clear affirmative numbered/exact-label
choices and pending-check commands execute through MCP without inference; open-ended wording goes
to the model with only the current public turn and bounded conversational history.

The engine validates IDs, conditions, inventory, effects and pending checks. Each mutation has a
request ID and expected revision. A retry with the same command/fingerprint returns the saved result;
a stale new command is rejected. State is persisted before a committed result is narrated. Narration
after mutation comes from that canonical public result, without a second model call.

An adventure definition is an immutable template with authored nodes and endings. Generated templates
must pass schema/reference/graph validation and bounded exploration of legal states before publication.
The validator cannot certify prose continuity. Preparation is asynchronous, with durable terminal
success/failure and one bounded repair attempt.

The browser, TV snapshot, SSE feed and comic use public turn snapshots. They exclude undiscovered
nodes, private engine variables and conversational transcripts. Session/conversation URLs act as
access links; there are no user accounts or OAuth in this local MVP.

The conversational mode stores v2 sessions separately from the classic mode's saved games. The
shared screen and comic must come from the same mode/session. Pause is a conversation flag; resuming
refreshes the current public turn rather than replaying an action.

Use one server process and a persistent `DATA_DIR`. The MCP URL remains loopback-only; Ollama can
use loopback or an operator-configured private LAN IPv4 origin. See the [contract](mcp-contract.md)
and [deployment guide](DEPLOYMENT.md).
