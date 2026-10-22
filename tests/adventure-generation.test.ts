import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AdventureService } from '../mcp-server/engine/service.js';
import { createMcpV2Server } from '../mcp-server/mcp-v2.js';
import { ConversationHost } from '../mcp-server/host/service.js';
import type { AdventureGenerationInput, AdventureGenerationProvider, AdventureRepairContext } from '../mcp-server/generation/provider.js';
import { JsonJobStore } from '../mcp-server/jobs/store.js';
import type { McpGateway } from '../mcp-server/host/mcp-gateway.js';
import { HostResponseSchema } from '../shared/host-schema.js';
import { PublicOperationSchema } from '../shared/session-schema.js';
import { AdventureDefinitionSchema } from '../shared/adventure-schema.js';
import { validateAdventureDefinition } from '../shared/adventure-validation.js';

const requestId = '77777777-7777-4777-8777-777777777777';

function playableAdventure() {
  return {
    schema_version: 1, id: 'moonlit-archive', version: 1, title: 'The Moonlit Archive', locale: 'en',
    genre: 'mystery', tone: 'curious', duration_minutes: 20, players: { min: 1, max: 4 },
    content_limits: ['No graphic violence'], objective: 'Discover who moved the moon map.',
    characters: [{ id: 'keeper-ada', name: 'Ada', description: 'An archivist who keeps careful notes.' }],
    items: [{ id: 'brass-lens', name: 'Brass lens', description: 'A lens polished to catch moonlight.' }],
    variables: { trust: { initial: 0, min: 0, max: 2 } }, initial_node_id: 'arrival',
    nodes: [
      { id: 'arrival', kind: 'scene', title: 'The archive steps', narration: 'Moonlight falls across the archive entrance.', secrets: ['A loose panel hides the map.'], affordances: [], choices: [
        { id: 'ask-keeper', label: 'Ask Ada about the map', action: 'Ask the keeper what changed.', conditions: [], effects: [{ kind: 'increment_variable', variable_id: 'trust', amount: 1 }], transition: { kind: 'direct', target_node_id: 'reading-room' } },
        { id: 'enter-room', label: 'Look in the reading room', action: 'Search the reading room for the map.', conditions: [], effects: [], transition: { kind: 'direct', target_node_id: 'ending-found' } },
      ] },
      { id: 'reading-room', kind: 'scene', title: 'The reading room', narration: 'A narrow beam reveals dust on the map stand.', secrets: [], affordances: [], choices: [
        { id: 'use-lens', label: 'Use the brass lens', action: 'Look for marks in the moonlight.', conditions: [{ kind: 'has_item', item_id: 'brass-lens' }], effects: [], transition: { kind: 'direct', target_node_id: 'ending-found' } },
        { id: 'ask-again', label: 'Ask Ada to check the catalog', action: 'Compare the catalog with the map stand.', conditions: [], effects: [], transition: { kind: 'direct', target_node_id: 'ending-found' } },
      ] },
      { id: 'ending-found', kind: 'ending', title: 'The map restored', narration: 'Together, the group returns the moon map to its place.', secrets: [], affordances: [], choices: [] },
    ],
  };
}

class FakeProvider implements AdventureGenerationProvider {
  calls: Array<{ input: AdventureGenerationInput; repair?: AdventureRepairContext }> = [];
  constructor(private readonly generated: unknown) {}
  async generateAdventure(input: AdventureGenerationInput, repair?: AdventureRepairContext): Promise<unknown> {
    this.calls.push({ input, repair });
    return this.generated;
  }
}

async function waitForTerminal(service: AdventureService, operationId: string) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await service.getOperationStatus({ operation_id: operationId });
    if (!('kind' in result) || result.kind !== 'error') {
      if (result.status !== 'pending') return result;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('Preparation job did not reach a terminal state.');
}

test('prepare_adventure durably generates, validates, publishes and starts a playable adventure', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rpg-generation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const adventureDir = path.join(root, 'adventures');
  const candidate = playableAdventure();
  candidate.objective = 'Discover the moon map. '.repeat(24).slice(0, 500);
  const provider = new FakeProvider(candidate);
  const service = new AdventureService({ dataDir: root, adventureDir, generatedAdventureDir: adventureDir, generationProvider: provider });
  const request = { request_id: requestId, premise: 'A misplaced map in a moonlit archive.', locale: 'en', preferences: { genre: 'mystery', player_count: 2 } };

  const pending = await service.prepareAdventure(request);
  assert.ok(!('kind' in pending && pending.kind === 'error'));
  assert.equal(pending.status, 'pending');
  assert.equal(pending.operation_id, requestId);
  const replay = await service.prepareAdventure(request);
  assert.deepEqual(replay, pending);
  const terminal = await waitForTerminal(service, requestId);
  assert.equal(terminal.status, 'ready');
  if (terminal.status !== 'ready') assert.fail('expected a ready operation');
  assert.deepEqual(terminal.result, { kind: 'adventure', adventure_id: 'moonlit-archive', title: 'The Moonlit Archive' });
  assert.equal(JSON.stringify(terminal).includes('A loose panel hides the map'), false);
  assert.equal(provider.calls.length, 1);
  assert.deepEqual(provider.calls[0]!.input, { premise: request.premise, locale: 'en', preferences: request.preferences });

  const files = await readdir(adventureDir);
  assert.deepEqual(files, ['moonlit-archive.en.json']);
  const written = JSON.parse(await readFile(path.join(adventureDir, files[0]!), 'utf8')) as { nodes: unknown[] };
  assert.equal(written.nodes.length, 3);
  const listed = await service.listAdventures({ locale: 'en' });
  if ('kind' in listed && listed.kind === 'error') throw new Error('expected adventure list');
  if (!('adventures' in listed)) throw new Error('expected adventure list');
  assert.equal(listed.adventures.some((adventure) => adventure.id === 'moonlit-archive'), true);
  assert.equal(listed.adventures[0]?.objective, candidate.objective, 'the catalogue accepts the full public objective allowed by the adventure schema');

  const started = await service.startSession({ request_id: '88888888-8888-4888-8888-888888888888', adventure_id: 'moonlit-archive', locale: 'en', players: ['Ari'] });
  if ('kind' in started && started.kind === 'error') throw new Error(`generated story was not playable: ${started.code}`);
  if (!('scene_id' in started)) throw new Error('generated story did not return an initial scene');
  assert.equal(started.scene_id, 'arrival');
  assert.equal(PublicOperationSchema.parse(terminal).status, 'ready');
});

test('structurally valid generated stories with a locked route or unsafe cumulative effects are repaired or rejected before publishing', async t => {
  for (const failure of ['locked-route', 'overflow']) {
    const root = await mkdtemp(path.join(os.tmpdir(), `rpg-generation-${failure}-`));
    t.after(() => rm(root, { recursive: true, force: true }));
    const candidate = AdventureDefinitionSchema.parse(playableAdventure());
    const room = candidate.nodes.find(node => node.id === 'reading-room');
    assert.ok(room && room.kind === 'scene');
    if (failure === 'locked-route') room.choices[1]!.conditions = [{ kind: 'has_item', item_id: 'brass-lens' }];
    else {
      candidate.variables.trust!.max = 1;
      room.choices[1]!.effects = [{ kind: 'increment_variable', variable_id: 'trust', amount: 1 }];
    }
    assert.equal(validateAdventureDefinition(candidate).ok, true, 'shape and structural references alone would accept this story');
    const provider = new FakeProvider(candidate);
    const service = new AdventureService({ dataDir: root, adventureDir: path.resolve('adventures'), generationProvider: provider });
    await service.prepareAdventure({ request_id: requestId, premise: 'A mystery with a safe route.', locale: 'en', preferences: {} });
    const terminal = await waitForTerminal(service, requestId);
    assert.equal(terminal.status, 'failed');
    assert.equal(provider.calls.length, 2, 'one repair is attempted before rejecting the graph');
    assert.match(provider.calls[1]?.repair?.issues.join(' ') ?? '', /reachable action|reachable state/);
    await assert.rejects(readdir(path.join(root, 'generated-adventures')), { code: 'ENOENT' });
  }
});

test('omitted generated action text safely inherits the public choice label', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rpg-generation-action-label-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const candidate = playableAdventure();
  for (const node of candidate.nodes) {
    if (node.kind === 'scene') for (const choice of node.choices) delete (choice as Partial<typeof choice>).action;
  }
  const provider = new FakeProvider(candidate);
  const events: unknown[] = [];
  const generatedDir = path.join(root, 'adventures');
  const service = new AdventureService({ dataDir: root, adventureDir: generatedDir, generatedAdventureDir: generatedDir, generationProvider: provider, generationTrace: event => events.push(event) });
  await service.prepareAdventure({ request_id: requestId, premise: 'A moon map goes missing.', locale: 'en', preferences: {} });
  const terminal = await waitForTerminal(service, requestId);
  assert.equal(terminal.status, 'ready', JSON.stringify(events));
  assert.equal(provider.calls.length, 1, 'deterministic copy from the visible label should not consume the LLM repair attempt');
  const saved = JSON.parse(await readFile(path.join(root, 'adventures', 'moonlit-archive.en.json'), 'utf8')) as { nodes: Array<{ choices?: Array<{ action: string; label: string }> }> };
  const choices = saved.nodes.flatMap((node) => node.choices ?? []);
  assert.ok(choices.length > 0);
  assert.ok(choices.every((choice) => choice.action === choice.label));
});

test('invalid graph gets exactly one repair attempt, then a safe failed operation', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rpg-generation-repair-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const invalid = playableAdventure();
  invalid.nodes[0]!.choices[0]!.transition.target_node_id = 'missing-node';
  const provider = new FakeProvider(invalid);
  const service = new AdventureService({ dataDir: root, adventureDir: path.join(root, 'authored'), generatedAdventureDir: path.join(root, 'adventures'), generationProvider: provider });
  await service.prepareAdventure({ request_id: requestId, premise: 'A map is missing.', locale: 'en', preferences: {} });
  const terminal = await waitForTerminal(service, requestId);
  assert.equal(terminal.status, 'failed');
  assert.equal(provider.calls.length, 2);
  assert.ok(provider.calls[1]?.repair?.issues.some((issue) => issue.includes('missing-node')));
  assert.equal(JSON.stringify(terminal).includes('missing-node'), false);
  assert.deepEqual(await readdir(path.join(root, 'adventures')).catch(() => []), []);
});

test('reused request ID with different input is rejected, and interrupted pending work recovers as failed', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rpg-generation-jobs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const store = new JsonJobStore(path.join(root, 'ops'));
  const base = {
    operation_id: requestId, kind: 'prepare_adventure' as const, owner_kind: 'request' as const, owner_id: requestId,
    request_id: requestId, input_fingerprint: `sha256:${'a'.repeat(64)}`, status: 'pending' as const,
    created_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  await store.createPending(base);
  await assert.rejects(() => store.createPending({ ...base, input_fingerprint: `sha256:${'b'.repeat(64)}` }), /different preparation/);
  await store.failInterrupted();
  const recovered = await store.get(requestId);
  assert.equal(recovered.status, 'failed');
  const publicRecovered = store.toPublic(recovered);
  if (publicRecovered.status !== 'failed') throw new Error('expected failed public operation');
  assert.match(publicRecovered.error.message, /interrupted/);

  const expiredId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  await store.createPending({ ...base, operation_id: expiredId, request_id: expiredId, owner_id: expiredId, expires_at: new Date(Date.now() - 1).toISOString() });
  const expired = await store.get(expiredId);
  assert.equal(expired.status, 'failed');
  const publicExpired = store.toPublic(expired);
  if (publicExpired.status !== 'failed') throw new Error('expected expired public operation');
  assert.match(publicExpired.error.message, /expired/);
});

test('host polls only its linked operation and stores the ready adventure in the locale catalogue', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rpg-generation-host-link-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const conversationId = '99999999-9999-4999-8999-999999999999';
  const operationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const ready = {
    operation_id: operationId, kind: 'prepare_adventure' as const, status: 'ready' as const,
    created_at: new Date().toISOString(), completed_at: new Date().toISOString(),
    result: { kind: 'adventure' as const, adventure_id: 'moonlit-archive', title: 'The Moonlit Archive' },
  };
  const summary = {
    id: 'moonlit-archive', version: 1, title: 'The Moonlit Archive', locale: 'en' as const, genre: 'mystery', tone: 'curious',
    duration_minutes: 20, players: { min: 1, max: 4 }, objective: 'Discover who moved the moon map.',
  };
  const calls: string[] = [];
  const mcp = {
    call: async (name: string) => {
      calls.push(name);
      return { isError: false, structuredContent: name === 'get_operation_status' ? ready : { adventures: [summary] } };
    },
    ollamaTools: async () => [], close: async () => undefined,
  } as unknown as McpGateway;
  const host = new ConversationHost({ dataDir: root, mcp, trace: () => undefined });
  t.after(() => host.close());
  await host.createConversation({ request_id: conversationId, locale: 'en' });
  await host.store.update(conversationId, (record) => {
    const response = HostResponseSchema.parse({ kind: 'operation', conversation: {
      conversation_id: conversationId, locale: 'en', session_id: null, paused: false, created_at: record.conversation.created_at,
    }, operation: {
      operation_id: operationId, kind: 'prepare_adventure', status: 'pending', created_at: ready.created_at,
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    } });
    return { record: { ...record, idempotency: [...record.idempotency, { request_id: operationId, fingerprint: `sha256:${'c'.repeat(64)}`, response }] }, value: undefined };
  });

  const response = await host.getPendingOperation(conversationId);
  assert.equal(response.kind, 'operation');
  if (response.kind !== 'operation') throw new Error('expected operation response');
  assert.equal(response.operation.status, 'ready');
  assert.deepEqual(calls, ['get_operation_status', 'list_adventures']);
  const stored = await host.store.get(conversationId);
  assert.equal(stored.catalogue[0]?.id, 'moonlit-archive');
  assert.deepEqual(stored.offered_adventure_ids, ['moonlit-archive']);
  assert.equal(stored.idempotency.at(-1)?.response.kind, 'operation');

  const unknown = await host.getPendingOperation('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.equal(unknown.kind, 'error');
  if (unknown.kind === 'error') assert.equal(unknown.code, 'NOT_FOUND');
});

test('official MCP client can prepare, poll, list and start a generated story', async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'rpg-generation-mcp-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const service = new AdventureService({ dataDir: root, generationProvider: new FakeProvider(playableAdventure()) });
  const app = express(); app.use(express.json());
  app.post('/mcp', async (req, res) => {
    const server = createMcpV2Server(service);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const http = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => http.once('listening', resolve));
  t.after(async () => { http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve())); });
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('No test server');
  const client = new Client({ name: 'rpg-generation-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}/mcp`)));

  const prepared = await client.callTool({ name: 'prepare_adventure', arguments: { request_id: requestId, premise: 'A moon map goes missing.', locale: 'en', preferences: {} } });
  const operation = prepared.structuredContent as { status: string; operation_id: string };
  assert.equal(operation.status, 'pending');
  let status: Record<string, unknown> | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await client.callTool({ name: 'get_operation_status', arguments: { operation_id: requestId } });
    status = result.structuredContent as Record<string, unknown>;
    if (status.status !== 'pending') break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.equal(status?.status, 'ready');
  assert.equal(JSON.stringify(status).includes('A loose panel hides the map'), false);
  const listed = await client.callTool({ name: 'list_adventures', arguments: { locale: 'en' } });
  assert.equal((listed.structuredContent as { adventures: Array<{ id: string }> }).adventures.some(({ id }) => id === 'moonlit-archive'), true);
  const started = await client.callTool({ name: 'start_session', arguments: { request_id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', adventure_id: 'moonlit-archive', locale: 'en', players: ['Ari'] } });
  assert.equal((started.structuredContent as { scene_id: string }).scene_id, 'arrival');
});
