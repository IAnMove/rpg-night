import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  EndSessionRequestSchema, GetOperationStatusRequestSchema, GetSessionRequestSchema, ListAdventuresRequestSchema,
  PrepareAdventureRequestSchema, ResolveCheckRequestSchema, StartSessionRequestSchema,
  SubmitActionRequestSchema,
} from '../shared/host-schema.js';
import { PublicErrorSchema } from '../shared/session-schema.js';
import { AdventureService } from './engine/service.js';

export function createMcpV2Server(service: AdventureService): McpServer {
  const server = new McpServer({ name: 'rpg-night', version: '2.0.0' }, {
    instructions: 'RPG Night v2 is the canonical session API. Use only returned public scene text, choices, affordances, inventory, and check prompts. Never invent or expose private adventure data or secrets. Submit exactly one player intent at a time and use returned identifiers and revisions. prepare_adventure returns a durable operation; poll get_operation_status using its operation_id.',
  });
  const result = (value: unknown) => {
    const error = PublicErrorSchema.safeParse(value);
    if (error.success) return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(error.data) }], structuredContent: { error: error.data } };
    return { content: [{ type: 'text' as const, text: JSON.stringify(value) }], structuredContent: value as Record<string, unknown> };
  };

  server.registerTool('list_adventures', {
    title: 'List adventures', description: 'List public adventures, optionally filtered by locale, genre, player count, and maximum duration. Genre filters accept partial labels and common English/Spanish equivalents.',
    inputSchema: ListAdventuresRequestSchema.shape,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async input => result(await service.listAdventures(input)));
  server.registerTool('prepare_adventure', {
    title: 'Prepare an adventure', description: 'Start asynchronous preparation of a validated adventure from a premise. Returns an operation to poll with get_operation_status; never returns the private graph.',
    inputSchema: PrepareAdventureRequestSchema.shape,
    annotations: { destructiveHint: false, idempotentHint: true, openWorldHint: true },
  }, async input => result(await service.prepareAdventure(input)));
  server.registerTool('get_operation_status', {
    title: 'Get operation status', description: 'Read a durable asynchronous operation state. A ready adventure result exposes only its public ID and title.',
    inputSchema: GetOperationStatusRequestSchema.shape,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async input => result(await service.getOperationStatus(input)));
  server.registerTool('start_session', {
    title: 'Start a session', description: 'Start a session from a listed adventure and player names. request_id is also the stable session identifier for safe retries.',
    inputSchema: StartSessionRequestSchema.shape,
    annotations: { destructiveHint: false, idempotentHint: true },
  }, async input => result(await service.startSession(input)));
  server.registerTool('get_session', {
    title: 'Read a session', description: 'Read the latest public turn for a session without changing its state.',
    inputSchema: GetSessionRequestSchema.shape,
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async input => result(await service.getSession(input)));
  server.registerTool('submit_action', {
    title: 'Submit a player action', description: 'Submit exactly one player intent using the current session revision. Match clear paraphrases to one listed choice and submit it now; do not only recommend the action. Otherwise submit one free_action with an affordance_id, target_id, item_id, and approach_id authorized by the current public turn. Ask the host for clarification instead of guessing when intent is ambiguous.',
    inputSchema: SubmitActionRequestSchema.shape,
    annotations: { destructiveHint: false, idempotentHint: true },
  }, async input => result(await service.submitAction(input)));
  server.registerTool('resolve_check', {
    title: 'Resolve a check', description: 'Resolve the pending server-side d20 check using its current check_id and session revision.',
    inputSchema: ResolveCheckRequestSchema.shape,
    annotations: { destructiveHint: false, idempotentHint: true },
  }, async input => result(await service.resolveCheck(input)));
  server.registerTool('end_session', {
    title: 'End a session', description: 'Close a session using its current revision. Repeated request_id calls replay the committed public result.',
    inputSchema: EndSessionRequestSchema.shape,
    annotations: { destructiveHint: false, idempotentHint: true },
  }, async input => result(await service.endSession(input)));
  return server;
}
