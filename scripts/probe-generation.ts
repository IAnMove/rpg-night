import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp, errorHandler } from '../mcp-server/app.js';
import { readConfig } from '../mcp-server/config.js';
import { Game } from '../mcp-server/game.js';
import { PublicOperationSchema, PublicTurnSchema } from '../shared/session-schema.js';

const port = Number(process.env.GENERATION_LIVE_PORT ?? 3103);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, 'GENERATION_LIVE_PORT must be an available high port.');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rpg-night-generation-live-'));
const reportDir = path.resolve('.work', 'generation-live');
await mkdir(reportDir, { recursive: true });
const config = readConfig({
  ...process.env,
  PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, HOST_MODE: 'disabled',
  RPG_MCP_URL: `http://127.0.0.1:${port}/mcp`,
});
const game = new Game(config); await game.init();
const app = createApp(config, game); app.use(errorHandler);
const server = app.listen(config.port, config.host);
const client = new Client({ name: 'rpg-night-generation-probe', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(`http://${config.host}:${config.port}/mcp`));
const requestId = randomUUID();
const startedAt = Date.now();
let reportPath = '';

try {
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject); });
  await client.connect(transport);
  const prepared = await client.callTool({ name: 'prepare_adventure', arguments: {
    request_id: requestId,
    premise: 'A rain-soaked clockwork lighthouse stops turning before a storm. A young keeper asks the group to discover the harmless fault and relight it together.',
    locale: 'en',
    preferences: { genre: 'mystery', tone: 'cozy', duration_minutes: 10, player_count: 2, content_limits: ['No graphic violence', 'Family friendly'] },
  } }, undefined, { timeout: 20_000 });
  assert.equal(prepared.isError, undefined, 'prepare_adventure should accept the bounded story brief.');
  let operation = PublicOperationSchema.parse(prepared.structuredContent);
  assert.equal(operation.status, 'pending', 'generation should return a durable pending operation.');
  const preparationStartedAt = Date.now();
  while (operation.status === 'pending' && Date.now() - preparationStartedAt < 210_000) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const status = await client.callTool({ name: 'get_operation_status', arguments: { operation_id: requestId } }, undefined, { timeout: 20_000 });
    assert.equal(status.isError, undefined, 'get_operation_status should succeed.');
    operation = PublicOperationSchema.parse(status.structuredContent);
  }
  assert.equal(operation.status, 'ready', `local adventure generation did not become ready: ${operation.status === 'failed' ? operation.error.message : 'timeout'}`);
  if (operation.status !== 'ready') throw new Error('Expected a validated adventure.');
  if (operation.result.kind !== 'adventure') throw new Error('Preparation returned a result of the wrong kind.');
  const adventureId = operation.result.adventure_id;

  const listed = await client.callTool({ name: 'list_adventures', arguments: { locale: 'en' } }, undefined, { timeout: 20_000 });
  assert.equal(listed.isError, undefined);
  const catalogue = listed.structuredContent as { adventures: Array<{ id: string; title: string; locale: string }> };
  const adventure = catalogue.adventures.find((item) => item.id === adventureId && item.locale === 'en');
  assert.ok(adventure, 'a ready operation must be present in the same-locale public catalogue.');

  const startId = randomUUID();
  const started = await client.callTool({ name: 'start_session', arguments: { request_id: startId, adventure_id: adventure.id, locale: 'en', players: ['Ada', 'Bo'] } }, undefined, { timeout: 20_000 });
  assert.equal(started.isError, undefined, 'the generated story must be playable.');
  let turn = PublicTurnSchema.parse(started.structuredContent);
  assert.equal(turn.revision, 1);
  assert.ok(turn.choices.length >= 2);
  const initialChoiceCount = turn.choices.length;
  for (let step = 1; turn.phase !== 'ended' && step <= 12; step++) {
    const requestIdForStep = randomUUID();
    let result: Awaited<ReturnType<Client['callTool']>>;
    if (turn.phase === 'awaiting_check' && turn.pending_check) {
      result = await client.callTool({ name: 'resolve_check', arguments: {
        session_id: turn.session_id, expected_revision: turn.revision, request_id: requestIdForStep, check_id: turn.pending_check.id,
      } }, undefined, { timeout: 20_000 });
    } else if (turn.phase === 'awaiting_choice' && turn.choices[0]) {
      result = await client.callTool({ name: 'submit_action', arguments: {
          session_id: turn.session_id, expected_revision: turn.revision, request_id: requestIdForStep,
          interaction: { kind: 'choice', choice_id: turn.choices[0].id, action_text: turn.choices[0].label },
        } }, undefined, { timeout: 20_000 });
    } else {
      throw new Error(`Generated adventure cannot continue from phase ${turn.phase}.`);
    }
    assert.equal(result.isError, undefined, 'a valid generated-story choice/check should succeed.');
    const next = PublicTurnSchema.parse(result.structuredContent);
    assert.equal(next.session_id, turn.session_id);
    assert.equal(next.revision, turn.revision + 1);
    turn = next;
  }
  assert.equal(turn.phase, 'ended', 'The validated generated story must reach an authored ending.');
  const report = {
    model: config.ollamaModel,
    provider: 'local Ollama through the configured MCP server provider',
    endpoint: '/mcp (Streamable HTTP; official MCP SDK)',
    operation: { status: operation.status, kind: operation.kind, locale: adventure.locale },
    adventure: { id: adventure.id, title: adventure.title, locale: adventure.locale },
    playable: { session_created: true, ended: turn.phase === 'ended', initial_choice_count: initialChoiceCount, committed_revisions: turn.revision },
    elapsed_ms: Date.now() - startedAt,
  };
  reportPath = path.join(reportDir, `generation-${new Date().toISOString().replaceAll(':', '-')}.json`);
  await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ ...report, report: reportPath }, null, 2));
} catch (error) {
  const failure = {
    model: config.ollamaModel,
    error: error instanceof Error ? error.message : 'Unknown generation probe failure',
    elapsed_ms: Date.now() - startedAt,
  };
  reportPath = path.join(reportDir, `generation-${new Date().toISOString().replaceAll(':', '-')}.json`);
  await writeFile(reportPath, JSON.stringify(failure, null, 2), 'utf8');
  console.error(JSON.stringify({ ...failure, report: reportPath }, null, 2));
  process.exitCode = 1;
} finally {
  await client.close().catch(() => undefined);
  await transport.close().catch(() => undefined);
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(dataDir, { recursive: true, force: true });
}
