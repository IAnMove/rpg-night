import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationHost } from '../mcp-server/host/service.js';
import type { McpGateway } from '../mcp-server/host/mcp-gateway.js';
import type { OllamaClient } from '../mcp-server/llm/ollama.js';
import { PublicTurnSchema, type PublicTurn } from '../shared/session-schema.js';

const conversationId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const turnRequestId = '33333333-3333-4333-8333-333333333333';

function gameTurn(revision: number, narration = 'A stone door stands ahead.', turnSessionId = sessionId): PublicTurn {
  return PublicTurnSchema.parse({
    schema_version: 2, session_id: turnSessionId, locale: 'en', revision, view_revision: revision,
    phase: 'awaiting_choice', scene_id: revision === 3 ? 'entrance' : 'doorway', narration,
    choices: [{ id: 'open-door', label: 'Open the stone door' }], affordances: [],
    pending_check: null, recent_outcome: null, inventory: [], recap: 'The group reached a stone door.',
    next_expected_input: 'Choose an option.', visual_status: 'ready',
  });
}

function mcpMock(initial: PublicTurn, updated: PublicTurn) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const mcp = {
    ollamaTools: async () => [{ type: 'function', function: { name: 'submit_action', parameters: { type: 'object' } } }],
    call: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      const turn = name === 'submit_action' ? updated : initial;
      return { isError: false, structuredContent: turn };
    },
    close: async () => undefined,
  } as unknown as McpGateway;
  return { mcp, calls };
}

function ollamaMock(answer: { content: string; tool_calls: Array<{ name: string; arguments: unknown }> }) {
  let calls = 0;
  const ollama = {
    chat: async () => {
      calls++;
      if (calls === 1) return { ...answer, elapsed_ms: 1 };
      throw new Error('The model is unavailable after choosing a tool. A committed action must not depend on another model call.');
    },
  } as unknown as OllamaClient;
  return ollama;
}

async function linkedHost(t: TestContext, ollama: OllamaClient, mcp: McpGateway, dir: string) {
  const host = new ConversationHost({ dataDir: dir, ollama, mcp, trace: () => undefined });
  t.after(() => host.close());
  const created = await host.createConversation({ request_id: conversationId, locale: 'en', session_id: sessionId });
  if (created.kind === 'error') assert.fail(`session link failed: ${created.code} ${created.message}`);
  assert.equal(created.kind, 'turn');
  return host;
}

test('host validates a model choice, injects linkage and revision, and persists the returned public turn', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpg-host-e2e-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const before = gameTurn(3);
  const after = gameTurn(4, 'The door opens into a quiet courtyard.');
  const { mcp, calls } = mcpMock(before, after);
  const ollama = ollamaMock({ content: '', tool_calls: [{ name: 'submit_action', arguments: { interaction: { kind: 'choice', choice_id: 'open-door', action_text: 'invented text' } } }] });
  const host = await linkedHost(t, ollama, mcp, dir);
  let publishedRevision: number | undefined;
  const unsubscribe = host.subscribePublicState(conversationId, state => { publishedRevision = state.turn?.revision; });
  t.after(unsubscribe);

  const response = await host.turn(conversationId, { request_id: turnRequestId, text: 'Open the door.', expected_revision: 3 });
  assert.equal(response.kind, 'turn');
  if (response.kind !== 'turn') assert.fail('expected public turn response');
  assert.equal(response.turn.revision, 4);
  assert.equal(response.turn.narration, 'The door opens into a quiet courtyard.');
  assert.equal(response.assistant_text, after.narration, 'Narration must reflect the committed turn without an additional model call.');

  const mutation = calls.find(({ name }) => name === 'submit_action');
  assert.ok(mutation);
  assert.deepEqual(mutation.args, {
    session_id: sessionId,
    expected_revision: 3,
    request_id: turnRequestId,
    interaction: { kind: 'choice', choice_id: 'open-door', action_text: 'Open the door.' },
  });
  const persisted = await host.store.get(conversationId);
  assert.equal(persisted.session_id, sessionId);
  assert.equal(persisted.turn?.revision, 4);
  assert.equal(persisted.turn?.scene_id, 'doorway');
  assert.deepEqual(persisted.public_turns.map(turn => turn.revision), [3, 4]);
  assert.equal(publishedRevision, 4, 'the public history event is emitted after the latest turn is durably stored');
  assert.equal(persisted.history.at(-2)?.content, 'Open the door.');
  const restored = await host.restoreConversation(conversationId);
  assert.equal(restored.kind, 'turn', 'restoring a linked conversation must not replay creation without its original session fingerprint');
  if (restored.kind === 'turn') assert.equal(restored.turn.revision, 4);
  const replay = await host.turn(conversationId, { request_id: turnRequestId, text: 'Open the door.', expected_revision: 3 });
  assert.deepEqual(replay, response);
  assert.equal(calls.filter(call => call.name === 'submit_action').length, 1);
});

test('an external MCP advance restores consistent public history and publishes the conflict snapshot', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpg-host-external-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let current = gameTurn(3);
  const mcp = {
    call: async () => ({ isError: false, structuredContent: current }), close: async () => undefined,
  } as unknown as McpGateway;
  const ollama = { chat: async () => { throw new Error('A stale turn must not invoke the model.'); } } as unknown as OllamaClient;
  const host = await linkedHost(t, ollama, mcp, dir);
  let publishedRevision = 0;
  t.after(host.subscribePublicState(conversationId, state => { publishedRevision = state.turn?.revision ?? 0; }));
  current = gameTurn(4, 'Another controller opened the door.');
  const response = await host.turn(conversationId, { request_id: turnRequestId, text: 'Open the door.', expected_revision: 3 });
  assert.equal(response.kind, 'error');
  if (response.kind !== 'error') assert.fail('expected a recoverable conflict');
  assert.equal(response.code, 'REVISION_CONFLICT');
  const state = await host.getPublicState(conversationId);
  assert.equal(state?.turn?.revision, 4);
  assert.deepEqual(state?.turns.map(turn => turn.revision), [3, 4]);
  assert.equal(publishedRevision, 4);
  const resumed = await host.resume(conversationId, { request_id: '55555555-5555-4555-8555-555555555555', expected_revision: 4 });
  assert.equal(resumed.kind, 'turn');
  assert.equal((await host.getPublicState(conversationId))?.turn?.revision, 4);
});

test('resuming after an external advance saves the latest turn and its public history together', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpg-host-resume-external-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let current = gameTurn(3);
  const mcp = { call: async () => ({ isError: false, structuredContent: current }), close: async () => undefined } as unknown as McpGateway;
  const host = await linkedHost(t, {} as OllamaClient, mcp, dir);
  await host.pause(conversationId, { request_id: turnRequestId, expected_revision: 3 });
  current = gameTurn(4);
  const resumed = await host.resume(conversationId, { request_id: '66666666-6666-4666-8666-666666666666', expected_revision: 3 });
  assert.equal(resumed.kind, 'turn');
  const state = await host.getPublicState(conversationId);
  assert.equal(state?.paused, false);
  assert.deepEqual(state?.turns.map(turn => turn.revision), [3, 4]);
});

test('an explicit numbered choice commits the authoritative MCP turn without trusting model narration', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpg-host-direct-choice-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const before = gameTurn(3);
  const after = gameTurn(4, 'The stone door opens into a quiet courtyard.');
  const { mcp, calls } = mcpMock(before, after);
  let modelCalls = 0;
  const ollama = { chat: async () => { modelCalls++; throw new Error('The model must not be trusted to apply an explicit public choice.'); } } as unknown as OllamaClient;
  const host = await linkedHost(t, ollama, mcp, dir);

  const response = await host.turn(conversationId, {
    request_id: turnRequestId, text: 'We explicitly choose the first option now: Open the stone door.', expected_revision: 3,
  });
  assert.equal(response.kind, 'turn');
  if (response.kind !== 'turn') assert.fail('expected public turn response');
  assert.equal(response.turn.revision, 4);
  assert.equal(response.assistant_text, after.narration);
  assert.equal(modelCalls, 0);
  const mutation = calls.find(({ name }) => name === 'submit_action');
  assert.ok(mutation);
  assert.deepEqual(mutation.args, {
    session_id: sessionId, expected_revision: 3, request_id: turnRequestId,
    interaction: { kind: 'choice', choice_id: 'open-door', action_text: 'We explicitly choose the first option now: Open the stone door.' },
  });
});

test('the model receives current flat action IDs and its free action is validated before MCP submission', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpg-host-flat-action-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const before = PublicTurnSchema.parse({
    ...gameTurn(3),
    affordances: [{
      id: 'inspect-door', resolution_choice_id: 'open-door', label: 'Inspect the door', summary: 'Look for a safe way to open it.',
      targets: [{ id: 'stone-door', label: 'Stone door' }], item_ids: ['brass-key'], approaches: [{ id: 'turn-key', label: 'Turn the key' }],
    }],
    inventory: [{ id: 'brass-key', name: 'Brass key', description: 'A small brass key.' }],
  });
  const after = gameTurn(4, 'The key turns in the stone door.');
  const { mcp, calls } = mcpMock(before, after);
  let modelCalls = 0;
  let submitActionSchema: Record<string, unknown> | undefined;
  const ollama = {
    chat: async (input: { tools?: Array<{ function: { name: string; parameters: Record<string, unknown> } }> }) => {
      modelCalls++;
      if (modelCalls === 1) {
        submitActionSchema = input.tools?.find(tool => tool.function.name === 'submit_action')?.function.parameters;
        return { content: '', tool_calls: [{ name: 'submit_action', arguments: {
          kind: 'free_action', affordance_id: 'inspect-door', target_id: 'stone-door', item_id: 'brass-key', approach_id: 'turn-key',
        } }], elapsed_ms: 1 };
      }
      return { content: 'The key turns.', tool_calls: [], elapsed_ms: 1 };
    },
  } as unknown as OllamaClient;
  const host = await linkedHost(t, ollama, mcp, dir);

  const response = await host.turn(conversationId, { request_id: turnRequestId, text: 'Turn the key in the stone door.', expected_revision: 3 });
  assert.equal(response.kind, 'turn');
  assert.ok(submitActionSchema);
  const schema = submitActionSchema as { properties: Record<string, { enum?: string[] }>; required: string[]; additionalProperties: boolean };
  assert.deepEqual(schema.required, ['kind', 'action_text']);
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.choice_id?.enum, ['open-door']);
  assert.deepEqual(schema.properties.affordance_id?.enum, ['inspect-door']);
  assert.deepEqual(schema.properties.target_id?.enum, ['stone-door']);
  assert.deepEqual(schema.properties.item_id?.enum, ['brass-key']);
  assert.deepEqual(schema.properties.approach_id?.enum, ['turn-key']);
  const mutation = calls.find(({ name }) => name === 'submit_action');
  assert.ok(mutation);
  assert.deepEqual(mutation.args.interaction, {
    kind: 'free_action', affordance_id: 'inspect-door', target_id: 'stone-door', item_id: 'brass-key', approach_id: 'turn-key',
    action_text: 'Turn the key in the stone door.',
  });
});

test('ambiguous player intent returns clarification without a game mutation', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpg-host-clarify-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const before = gameTurn(3);
  const { mcp, calls } = mcpMock(before, gameTurn(4));
  const ollama = ollamaMock({ content: '', tool_calls: [{ name: 'ask_clarification', arguments: { question: 'Do you want to open the door or inspect it?' } }] });
  const host = await linkedHost(t, ollama, mcp, dir);

  const response = await host.turn(conversationId, { request_id: turnRequestId, text: 'Maybe open the door, or should we wait?', expected_revision: 3 });
  assert.equal(response.kind, 'clarification');
  if (response.kind !== 'clarification') assert.fail('expected clarification response');
  assert.equal(response.turn.revision, 3);
  assert.equal(response.question, 'Do you want to open the door or inspect it?');
  assert.equal(calls.some(({ name }) => ['submit_action', 'resolve_check', 'end_session', 'start_session'].includes(name)), false);
  const persisted = await host.store.get(conversationId);
  assert.equal(persisted.turn?.revision, 3);
  assert.equal(persisted.idempotency.at(-1)?.response.kind, 'clarification');
});

test('an explicitly undecided group gets current public options as a clarification without calling the model', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpg-host-undecided-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const before = PublicTurnSchema.parse({
    ...gameTurn(3),
    choices: [
      { id: 'talk-warden', label: 'Talk with Warden Elin' },
      { id: 'help-ferryman', label: 'Help Oren at the ferry' },
    ],
  });
  const { mcp, calls } = mcpMock(before, gameTurn(4));
  let modelCalls = 0;
  const ollama = { chat: async () => { modelCalls++; throw new Error('The host should ask a clarification before model interpretation.'); } } as unknown as OllamaClient;
  const host = await linkedHost(t, ollama, mcp, dir);

  const response = await host.turn(conversationId, {
    request_id: turnRequestId,
    text: "We're split between talking with Warden Elin and helping Oren at the ferry. We haven't chosen. Ask us a question so we can decide.",
    expected_revision: 3,
  });
  assert.equal(response.kind, 'clarification');
  if (response.kind !== 'clarification') assert.fail('expected a choice clarification');
  assert.equal(response.turn.revision, 3);
  assert.match(response.question, /Talk with Warden Elin or Help Oren at the ferry/);
  assert.equal(modelCalls, 0);
  assert.equal(calls.some(({ name }) => ['submit_action', 'resolve_check', 'end_session', 'start_session'].includes(name)), false);
});

test('an explicit new-adventure request starts the canonical MCP preparation without model misrouting', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpg-host-prepare-direct-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const mcp = {
    ollamaTools: async () => [],
    call: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return {
        isError: false,
        structuredContent: {
          operation_id: turnRequestId, kind: 'prepare_adventure', status: 'pending',
          created_at: '2026-10-22T10:00:00.000Z', expires_at: '2026-10-22T10:10:00.000Z',
        },
      };
    },
    close: async () => undefined,
  } as unknown as McpGateway;
  let modelCalls = 0;
  const ollama = { chat: async () => { modelCalls++; return { content: 'I can help you browse the existing adventures.', tool_calls: [], elapsed_ms: 1 }; } } as unknown as OllamaClient;
  const host = new ConversationHost({ dataDir: dir, ollama, mcp, trace: () => undefined });
  t.after(() => host.close());
  const created = await host.createConversation({ request_id: conversationId, locale: 'en' });
  assert.equal(created.kind, 'message');

  const premise = 'Create a new short cozy mystery about a lighthouse before a storm.';
  const response = await host.turn(conversationId, { request_id: turnRequestId, text: premise });
  assert.equal(response.kind, 'operation');
  if (response.kind !== 'operation') assert.fail('expected adventure preparation operation');
  assert.equal(response.operation.kind, 'prepare_adventure');
  assert.equal(response.operation.status, 'pending');
  assert.equal(modelCalls, 0);
  assert.deepEqual(calls, [{
    name: 'prepare_adventure',
    args: { request_id: turnRequestId, premise, locale: 'en', preferences: {} },
  }]);

  const secondConversation = '44444444-4444-4444-8444-444444444444';
  const secondCreated = await host.createConversation({ request_id: secondConversation, locale: 'en' });
  assert.equal(secondCreated.kind, 'message');
  const refusal = await host.turn(secondConversation, {
    request_id: '55555555-5555-4555-8555-555555555555', text: 'Do not create a new adventure; just tell us what you can do.',
  });
  assert.equal(refusal.kind, 'message');
  assert.equal(modelCalls, 1);
  assert.equal(calls.length, 1, 'A negated generation request must not start a preparation job.');
});

test('host replaces a model-invented adventure ID with the human-selected offered ID', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpg-host-start-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const summary = {
    id: 'elderglen', version: 1, title: 'The Bell Beneath Elderglen', locale: 'en', genre: 'mystery', tone: 'hopeful',
    duration_minutes: 30, players: { min: 1, max: 4 }, objective: 'Find the missing bell.',
  } as const;
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const mcp = {
    ollamaTools: async () => [
      { type: 'function', function: { name: 'list_adventures', parameters: { type: 'object' } } },
      { type: 'function', function: { name: 'start_session', parameters: { type: 'object' } } },
    ],
    call: async (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      if (name === 'list_adventures') return { isError: false, structuredContent: { adventures: [summary] } };
      return { isError: false, structuredContent: gameTurn(1, 'The adventure begins.', turnRequestId) };
    },
    close: async () => undefined,
  } as unknown as McpGateway;
  let modelCalls = 0;
  const ollama = { chat: async () => {
    modelCalls++;
    if (modelCalls === 1) return { content: 'Your adventure has begun. Would you like to start?', tool_calls: [], elapsed_ms: 1 };
    if (modelCalls === 2) return { content: '', tool_calls: [{ name: 'start_session', arguments: { adventure_id: 'model-invented-id', players: ['Lee'] } }], elapsed_ms: 1 };
    throw new Error('No narration model call is allowed after the confirmed start.');
  } } as unknown as OllamaClient;
  const host = new ConversationHost({ dataDir: dir, ollama, mcp, trace: () => undefined });
  t.after(() => host.close());
  const created = await host.createConversation({ request_id: conversationId, locale: 'en' });
  assert.equal(created.kind, 'message');
  await host.store.update(conversationId, (record) => ({
    record: { ...record, catalogue: [summary], offered_adventure_ids: ['elderglen'] }, value: undefined,
  }));

  const response = await host.turn(conversationId, { request_id: turnRequestId, text: 'Start The Bell Beneath Elderglen for Lee.' });
  assert.equal(response.kind, 'turn');
  if (response.kind === 'turn') assert.equal(response.assistant_text, 'The adventure begins.');
  assert.equal(modelCalls, 2, 'an unconfirmed prose start gets one tool-bound retry before any story is presented');
  const started = calls.find(({ name }) => name === 'start_session');
  assert.ok(started);
  assert.deepEqual(started.args, { adventure_id: 'elderglen', locale: 'en', request_id: turnRequestId, players: ['Lee'] });
  assert.equal(calls.some(({ name }) => name === 'list_adventures'), true);
  assert.deepEqual((await host.store.get(conversationId)).player_names, ['Lee'], 'Explicitly supplied player names should survive a host restart.');
});

test('selecting a just-prepared adventure starts that story instead of allowing a second preparation', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpg-host-select-generated-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const summary = { id: 'new-lighthouse', version: 1, title: 'The Newly Prepared Lighthouse', locale: 'en', genre: 'mystery', tone: 'cozy', duration_minutes: 10, players: { min: 1, max: 4 }, objective: 'Find the missing book.' };
  const calls: string[] = [];
  const startRequestId = '77777777-7777-4777-8777-777777777777';
  const mcp = {
    ollamaTools: async () => ['list_adventures', 'prepare_adventure', 'get_operation_status', 'start_session'].map(name => ({ type: 'function', function: { name, parameters: { type: 'object' } } })),
    call: async (name: string) => {
      calls.push(name);
      const operation = { operation_id: turnRequestId, kind: 'prepare_adventure', created_at: '2026-10-22T12:00:00.000Z' };
      const data = name === 'prepare_adventure' ? { ...operation, status: 'pending', expires_at: '2026-10-22T12:05:00.000Z' }
        : name === 'get_operation_status' ? { ...operation, status: 'ready', completed_at: '2026-10-22T12:00:01.000Z', result: { kind: 'adventure', adventure_id: summary.id, title: summary.title } }
          : name === 'list_adventures' ? { adventures: [summary] } : gameTurn(1, 'A new story begins at the lighthouse.', startRequestId);
      return { isError: false, structuredContent: data };
    },
    close: async () => undefined,
  } as unknown as McpGateway;
  let modelCalls = 0;
  const ollama = { chat: async (input: { messages: Array<{ content: string }>; tools: Array<{ function: { name: string } }> }) => {
    modelCalls++;
    assert.match(input.messages[0]!.content, /already prepared successfully/);
    assert.match(input.messages[0]!.content, /explicitly selected/);
    const incorrectlyAllowed = input.tools.some(tool => tool.function.name === 'prepare_adventure');
    return { content: '', elapsed_ms: 1, tool_calls: [{ name: incorrectlyAllowed ? 'prepare_adventure' : 'start_session', arguments: incorrectlyAllowed ? { premise: 'Create the same lighthouse again.', preferences: {} } : { adventure_id: summary.id, players: ['Lee'] } }] };
  } } as unknown as OllamaClient;
  const host = new ConversationHost({ dataDir: dir, mcp, ollama, trace: () => undefined });
  t.after(() => host.close());
  await host.createConversation({ request_id: conversationId, locale: 'en' });
  const preparation = await host.turn(conversationId, { request_id: turnRequestId, text: 'Create a new cozy mystery for Lee.' });
  assert.equal(preparation.kind, 'operation');
  const ready = await host.getPendingOperation(conversationId);
  assert.equal(ready.kind, 'operation');
  const started = await host.turn(conversationId, { request_id: startRequestId, text: `Start ${summary.title} for Lee.` });
  assert.equal(started.kind, 'turn');
  assert.equal(calls.filter(name => name === 'prepare_adventure').length, 1);
  assert.equal(calls.filter(name => name === 'start_session').length, 1);
  assert.equal(modelCalls, 1);
});
