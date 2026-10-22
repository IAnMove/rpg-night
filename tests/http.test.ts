import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp, errorHandler } from '../mcp-server/app.js';
import { Game } from '../mcp-server/game.js';
import { readConfig } from '../mcp-server/config.js';
import type { Session } from '../shared/types.js';

test('changing PORT keeps the conversational host on the same canonical MCP server', () => {
  assert.equal(readConfig({ PORT: '3101' }).mcpUrl, 'http://127.0.0.1:3101/mcp');
  assert.equal(readConfig({ PORT: '3101', RPG_MCP_URL: 'http://localhost:3200/mcp' }).mcpUrl, 'http://localhost:3200/mcp');
});

async function fixture(t: test.TestContext) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpg-night-http-'));
  const config = readConfig({ DATA_DIR: dir }); const game = new Game(config); await game.init();
  const app = createApp(config, game); app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('No test server');
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${address.port}`;
  const post = (url: string, data: unknown) => fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  return { base, post, game };
}
test('HTTP play, validation, illustrations and comic download work end to end', async t => {
  const { base, post } = await fixture(t);
  const bad = await post('/api/sessions', { world: 'bogus' }); assert.equal(bad.status, 400);
  const created = await post('/api/sessions', { world: 'fantasy', language: 'es', players: ['Ana'] }); assert.equal(created.status, 201);
  const session = await created.json() as Session;
  const image = await fetch(base + session.scenes[0].imageUrl); assert.equal(image.status, 200); assert.match(await image.text(), /<svg/);
  const preview = await fetch(base + '/api/preview/space.svg'); assert.equal(preview.status, 200);
  const choice = session.scenes[0].choices[0];
  const next = await post(`/api/sessions/${session.id}/actions`, { action: choice.text, choiceId: choice.id }); assert.equal(next.status, 200);
  const stale = await post(`/api/sessions/${session.id}/actions`, { action: choice.text, choiceId: choice.id }); assert.equal(stale.status, 409);
  const ended = await post(`/api/sessions/${session.id}/end`, {}); assert.equal((await ended.json() as Session).status, 'ended');
  const comic = await fetch(`${base}/api/sessions/${session.id}/comic.svg`); assert.equal(comic.status, 200); assert.match(comic.headers.get('content-disposition')!, /attachment/); assert.match(await comic.text(), /data:image/);
  const json = await fetch(base + '/api/sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{broken' }); assert.equal(json.status, 400);
  const cross = await fetch(base + '/api/config', { headers: { Origin: 'https://evil.example' } }); assert.equal(cross.status, 403);
  assert.equal((await fetch(base + '/api/unknown')).status, 404);
});
test('SSE sends initial state and live updates, then removes disconnected listener', async t => {
  const { base, game } = await fixture(t); const session = await game.start({ world: 'space', language: 'en', players: ['Lee'] });
  const abort = new AbortController(); const response = await fetch(`${base}/api/sessions/${session.id}/events`, { signal: abort.signal });
  assert.equal(response.headers.get('content-type')?.includes('text/event-stream'), true);
  const reader = response.body!.getReader(); const first = await reader.read(); assert.match(new TextDecoder().decode(first.value), /event: session/);
  await game.dice(session.id, {}); const update = await reader.read(); assert.match(new TextDecoder().decode(update.value), /"lastRoll":\{/);
  abort.abort(); await reader.cancel().catch(() => undefined);
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(game.events.listenerCount(session.id), 0);
});
test('official MCP client negotiates transport and invokes all five game tools', async t => {
  const { base } = await fixture(t);
  const client = new Client({ name: 'rpg-night-integration-test', version: '1.0.0' });
  t.after(() => client.close());
  await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp/legacy')));
  const tools = await client.listTools(); assert.equal(tools.tools.length, 5);
  const created = await client.callTool({ name: 'start_adventure', arguments: { world: 'mystery', language: 'en', players: ['Sam'] } });
  assert.equal(created.isError, undefined);
  const session = (created.structuredContent as { session: Session }).session; assert.ok(session.id);
  const rolled = await client.callTool({ name: 'roll_dice', arguments: { session_id: session.id, sides: 20 } }); assert.equal(rolled.isError, undefined);
  const choice = session.scenes[0].choices[1];
  const moved = await client.callTool({ name: 'player_action', arguments: { session_id: session.id, action: choice.text, choice_id: choice.id } });
  assert.equal((moved.structuredContent as { session: Session }).session.scenes.length, 2);
  const read = await client.callTool({ name: 'get_scene', arguments: { session_id: session.id } }); assert.equal((read.structuredContent as { session: Session }).session.scenes.length, 2);
  const end = await client.callTool({ name: 'end_session', arguments: { session_id: session.id } }); assert.equal((end.structuredContent as { session: Session }).session.status, 'ended');
  const invalid = await client.callTool({ name: 'get_scene', arguments: { session_id: 'not-a-uuid' } }); assert.equal(invalid.isError, true);
});
test('MCP explicitly negotiates the 2025-11-25 protocol revision', async t => {
  const { base } = await fixture(t);
  const response = await fetch(base + '/mcp/legacy', { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'protocol-check', version: '1.0.0' } } }) });
  assert.equal(response.status, 200); const body = await response.json() as { result: { protocolVersion: string } }; assert.equal(body.result.protocolVersion, '2025-11-25');
});
