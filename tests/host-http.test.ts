import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp, errorHandler, type HostController } from '../mcp-server/app.js';
import { Game } from '../mcp-server/game.js';
import { readConfig } from '../mcp-server/config.js';
import type { HostResponse } from '../shared/host-schema.js';

const conversationId = '22222222-2222-4222-8222-222222222222';
const requestId = '11111111-1111-4111-8111-111111111111';

test('host HTTP routes forward create, turn, pause and resume through the conversation controller', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpg-night-host-http-'));
  const config = readConfig({ DATA_DIR: dir });
  const calls: Array<{ method: string; id?: string; input?: unknown; signal?: AbortSignal }> = [];
  const response = (paused = false): HostResponse => ({
    kind: 'message',
    conversation: { conversation_id: conversationId, locale: 'es', session_id: null, paused, created_at: '2026-10-22T12:00:00.000Z' },
    assistant_text: '¿Qué aventura os apetece jugar?',
  });
  const conversation = response();
  assert.equal(conversation.kind, 'message');
  const pending: HostResponse = {
    kind: 'operation', conversation: conversation.conversation,
    operation: { operation_id: '55555555-5555-4555-8555-555555555555', kind: 'prepare_adventure', status: 'pending', created_at: '2026-10-22T12:00:00.000Z', expires_at: '2026-10-22T12:05:00.000Z' },
  };
  const host: HostController = {
    async createConversation(input) { calls.push({ method: 'create', input }); return response(); },
    async restoreConversation(id) { calls.push({ method: 'restore', id }); return response(); },
    async turn(id, input, signal) { calls.push({ method: 'turn', id, input, signal }); return response(); },
    async pause(id, input) { calls.push({ method: 'pause', id, input }); return response(true); },
    async resume(id, input) { calls.push({ method: 'resume', id, input }); return response(false); },
    async getPendingOperation(id) { calls.push({ method: 'operation', id }); return pending; },
    async getPublicState(id) { calls.push({ method: 'public_state', id }); return { conversation_id: id, locale: 'es', session_id: null, paused: false, turn: null, turns: [] }; },
    subscribePublicState(id) { calls.push({ method: 'subscribe', id }); return () => calls.push({ method: 'unsubscribe', id }); },
  };
  const game = new Game(config); await game.init();
  const app = createApp(config, game, undefined, host); app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (url: string, body: unknown) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  const created = await post('/api/host/conversations', { request_id: requestId, locale: 'es' });
  assert.equal(created.status, 201);
  assert.equal((await created.json() as HostResponse).kind, 'message');
  const restored = await fetch(`${base}/api/host/conversations/${conversationId}`);
  assert.equal(restored.status, 200);
  assert.equal((await restored.json() as HostResponse).kind, 'message');
  assert.equal(calls.at(-1)?.method, 'restore');

  const input = { request_id: '33333333-3333-4333-8333-333333333333', text: 'Muéstranos las aventuras' };
  const turn = await post(`/api/host/conversations/${conversationId}/turns`, input);
  assert.equal(turn.status, 200);
  assert.equal(calls.at(-1)?.method, 'turn');
  assert.equal(calls.at(-1)?.id, conversationId);
  assert.ok(calls.at(-1)?.signal instanceof AbortSignal);
  assert.deepEqual(calls.at(-1)?.input, input);

  const pauseBody = { request_id: '44444444-4444-4444-8444-444444444444', expected_revision: 1 };
  assert.equal((await post(`/api/host/conversations/${conversationId}/pause`, pauseBody)).status, 200);
  assert.equal(calls.at(-1)?.method, 'pause');
  assert.deepEqual(calls.at(-1)?.input, pauseBody);
  assert.equal((await post(`/api/host/conversations/${conversationId}/resume`, pauseBody)).status, 200);
  assert.equal(calls.at(-1)?.method, 'resume');

  const operation = await fetch(`${base}/api/host/conversations/${conversationId}/operation`);
  assert.equal(operation.status, 200);
  assert.equal((await operation.json() as HostResponse).kind, 'operation');
  assert.equal(calls.at(-1)?.method, 'operation');
  assert.equal(calls.at(-1)?.id, conversationId);

  const tv = await fetch(`${base}/api/host/conversations/${conversationId}/tv`);
  assert.equal(tv.status, 200);
  assert.equal((await tv.json() as { conversation_id: string }).conversation_id, conversationId);
  const comic = await fetch(`${base}/api/host/conversations/${conversationId}/comic.svg`);
  assert.equal(comic.status, 200);
  assert.match(await comic.text(), /<svg/);
  const eventController = new AbortController();
  const events = await fetch(`${base}/api/host/conversations/${conversationId}/events`, { signal: eventController.signal });
  assert.equal(events.status, 200);
  const reader = events.body?.getReader();
  assert.ok(reader);
  const firstEvent = await reader.read();
  assert.match(new TextDecoder().decode(firstEvent.value), /event: public-state/);
  eventController.abort();
  await reader.cancel().catch(() => undefined);

  assert.equal((await post('/api/host/conversations/not-a-uuid/turns', input)).status, 400);
  assert.equal(calls.some(({ method }) => method === 'subscribe'), true);
  assert.equal(calls.some(({ method }) => method === 'unsubscribe'), true);
});

test('host routes report when conversational mode is disabled', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpg-night-host-disabled-'));
  const config = readConfig({ DATA_DIR: dir, HOST_MODE: 'disabled' });
  const game = new Game(config); await game.init();
  const app = createApp(config, game); app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });
  const response = await fetch(`http://127.0.0.1:${address.port}/api/host/conversations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ request_id: requestId, locale: 'es' }),
  });
  assert.equal(response.status, 503);
});

test('host illustrations resolve only already public revisions and never arbitrary or future scenes', async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpg-host-art-'));
  const turn = {
    schema_version: 2 as const, session_id: requestId, locale: 'en' as const, revision: 1, view_revision: 1,
    phase: 'ended' as const, scene_id: 'public-bridge', narration: 'The party crosses the moonlit bridge.',
    choices: [], affordances: [], pending_check: null, recent_outcome: null, inventory: [], recap: '', next_expected_input: '', visual_status: 'ready' as const,
  };
  const host = {
    getPublicState: async (id: string) => id === conversationId ? { conversation_id: id, locale: 'en' as const, session_id: requestId, paused: false, turn, turns: [turn] } : null,
  } as HostController;
  const config = readConfig({ DATA_DIR: dir });
  const game = new Game(config); await game.init();
  const app = createApp(config, game, undefined, host); app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${address.port}/api/host/conversations/${conversationId}/art`;
  const visible = await fetch(`${base}/1.svg`);
  assert.equal(visible.status, 200);
  assert.match(visible.headers.get('content-type') ?? '', /image\/svg\+xml/);
  assert.match(await visible.text(), /storybook landscape/);
  assert.equal((await fetch(`${base}/2.svg`)).status, 404);
  assert.equal((await fetch(`${base}/unplayed-ending.svg`)).status, 400);
});
