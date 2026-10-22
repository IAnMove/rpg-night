import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp, errorHandler } from '../mcp-server/app.js';
import { readConfig } from '../mcp-server/config.js';
import { Game } from '../mcp-server/game.js';
import { AdventureService } from '../mcp-server/engine/service.js';
import type { PublicTurn } from '../shared/session-schema.js';

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpg-night-mcp-v2-'));
  const config = readConfig({ DATA_DIR: dir });
  const game = new Game(config); await game.init();
  const service = new AdventureService({ dataDir: dir, engineDependencies: { rollD20: () => 20 } });
  const app = createApp(config, game, service); app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test server');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  return { base: `http://127.0.0.1:${address.port}` };
}

function turn(result: Awaited<ReturnType<Client['callTool']>>): PublicTurn {
  const value = result.structuredContent as (PublicTurn & { turn?: PublicTurn }) | undefined;
  assert.ok(value?.session_id, JSON.stringify(result));
  return value.turn ?? value;
}

function errorCode(result: Awaited<ReturnType<Client['callTool']>>): string {
  const value = result.structuredContent as { error?: { code?: string } } | undefined;
  assert.equal(result.isError, true);
  assert.ok(value?.error?.code, JSON.stringify(result));
  return value.error.code;
}

test('official MCP client gets canonical v2 catalogue, 2025-11-25 handshake, and executes an adventure lifecycle', async (t) => {
  const { base } = await fixture(t);
  const client = new Client({ name: 'rpg-night-v2-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  assert.equal(client.getServerVersion()?.version, '2.0.0');
  const handshake = await fetch(`${base}/mcp`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'revision-check', version: '1.0.0' } } }),
  });
  assert.equal(handshake.status, 200);
  assert.equal(((await handshake.json()) as { result: { protocolVersion: string } }).result.protocolVersion, '2025-11-25');
  const catalog = await client.listTools();
  assert.deepEqual(catalog.tools.map((tool) => tool.name).sort(), [
    'end_session', 'get_operation_status', 'get_session', 'list_adventures', 'prepare_adventure', 'resolve_check', 'start_session', 'submit_action',
  ]);
  assert.equal(catalog.tools.some((tool) => ['start_adventure', 'player_action', 'roll_dice', 'get_scene'].includes(tool.name)), false);

  const listed = await client.callTool({ name: 'list_adventures', arguments: { locale: 'es', genre: 'misterio acogedor', players: 1, duration_minutes: 20 } });
  const summaries = listed.structuredContent as { adventures: Array<{ id: string; locale: string }> };
  assert.deepEqual(summaries.adventures.map(({ id, locale }) => ({ id, locale })), [{ id: 'elderglen', locale: 'es' }]);
  const translatedGenre = await client.callTool({ name: 'list_adventures', arguments: { locale: 'es', genre: 'mystery', players: 2, duration_minutes: 20 } });
  assert.deepEqual((translatedGenre.structuredContent as { adventures: Array<{ id: string; locale: string }> }).adventures.map(({ id, locale }) => ({ id, locale })), [{ id: 'elderglen', locale: 'es' }]);
  const absent = await client.callTool({ name: 'list_adventures', arguments: { locale: 'es', genre: 'science fiction' } });
  assert.deepEqual((absent.structuredContent as { adventures: unknown[] }).adventures, []);

  const startArgs = { request_id: '11111111-1111-4111-8111-111111111111', adventure_id: 'elderglen', locale: 'en', players: ['Sam'] };
  const started = await client.callTool({ name: 'start_session', arguments: startArgs });
  const firstTurn = turn(started);
  assert.equal(firstTurn.session_id, startArgs.request_id);
  assert.equal(firstTurn.scene_id, 'arrival');
  assert.equal(JSON.stringify(started.structuredContent).includes('jammed lantern mechanism'), false);
  assert.equal(JSON.stringify(started.structuredContent).includes('event_log'), false);
  assert.deepEqual(turn(await client.callTool({ name: 'start_session', arguments: startArgs })), firstTurn);
  assert.equal(errorCode(await client.callTool({ name: 'start_session', arguments: { ...startArgs, players: ['Different'] } })), 'IDEMPOTENCY_KEY_REUSED');
  const spanish = turn(await client.callTool({ name: 'start_session', arguments: {
    ...startArgs, request_id: '44444444-4444-4444-8444-444444444444', locale: 'es',
  } }));
  assert.match(spanish.narration, /La lluvia/);
  assert.equal(turn(await client.callTool({ name: 'get_session', arguments: { session_id: spanish.session_id } })).narration, spanish.narration);

  let current = turn(await client.callTool({ name: 'get_session', arguments: { session_id: firstTurn.session_id } }));
  assert.equal(current.revision, firstTurn.revision);
  const choose = async (choiceId: string) => {
    const result = await client.callTool({ name: 'submit_action', arguments: {
      session_id: current.session_id, expected_revision: current.revision,
      request_id: crypto.randomUUID(), interaction: { kind: 'choice', choice_id: choiceId, action_text: 'We choose this path.' },
    } });
    current = turn(result);
  };
  await choose('visit-green');
  await choose('ask-warden');
  await choose('carry-message');
  assert.equal(current.scene_id, 'bell-tower');
  await choose('test-lever');
  assert.equal(current.phase, 'awaiting_check');
  const checkId = current.pending_check!.id;
  current = turn(await client.callTool({ name: 'resolve_check', arguments: {
    session_id: current.session_id, expected_revision: current.revision, request_id: crypto.randomUUID(), check_id: checkId,
  } }));
  assert.equal(current.scene_id, 'gate');
  await choose('ring-warning');
  assert.equal(current.phase, 'ended');

  const separateStart = { ...startArgs, request_id: '22222222-2222-4222-8222-222222222222' };
  const separate = turn(await client.callTool({ name: 'start_session', arguments: separateStart }));
  const closed = turn(await client.callTool({ name: 'end_session', arguments: {
    session_id: separate.session_id, expected_revision: separate.revision, request_id: crypto.randomUUID(),
  } }));
  assert.equal(closed.phase, 'ended');
  assert.equal(turn(await client.callTool({ name: 'get_session', arguments: { session_id: separate.session_id } })).phase, 'ended');
});

test('prepare_adventure reports an explicit unavailable-provider error', async (t) => {
  const { base } = await fixture(t);
  const client = new Client({ name: 'rpg-night-provider-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  const result = await client.callTool({ name: 'prepare_adventure', arguments: {
    request_id: '33333333-3333-4333-8333-333333333333', premise: 'A village mystery', locale: 'en', preferences: {},
  } });
  assert.equal(errorCode(result), 'OPERATION_FAILED');
});
