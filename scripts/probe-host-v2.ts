import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createApp, errorHandler } from '../mcp-server/app.js';
import { readConfig } from '../mcp-server/config.js';
import { Game } from '../mcp-server/game.js';
import { ConversationHost } from '../mcp-server/host/service.js';
import { McpGateway } from '../mcp-server/host/mcp-gateway.js';
import { OllamaClient } from '../mcp-server/llm/ollama.js';
import { HostPublicStateSchema, HostResponseSchema, type HostResponse } from '../shared/host-schema.js';

const port = Number(process.env.HOST_LIVE_PORT ?? 3102);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, 'HOST_LIVE_PORT must be an available high port.');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rpg-night-live-v2-'));
const reportDir = path.resolve('.work', 'host-live');
await mkdir(reportDir, { recursive: true });
const trace: Array<{ component: string; outcome: string; name?: string; elapsed_ms?: number; code?: string }> = [];
const config = readConfig({
  ...process.env,
  PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, HOST_MODE: 'ollama',
  RPG_MCP_URL: `http://127.0.0.1:${port}/mcp`,
});
const game = new Game(config); await game.init();
const host = new ConversationHost({
  dataDir,
  ollama: new OllamaClient({ baseUrl: config.ollamaBaseUrl, model: config.ollamaModel }),
  mcp: new McpGateway({ url: config.mcpUrl }),
  trace: event => trace.push(event),
});
const app = createApp(config, game, undefined, host); app.use(errorHandler);
const server = app.listen(config.port, config.host);
const base = `http://${config.host}:${config.port}`;
const startedAt = Date.now();
const cases: Array<{ name: string; kind: string; elapsed_ms: number }> = [];

async function post(url: string, body: unknown): Promise<HostResponse> {
  const response = await fetch(base + url, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  const value: unknown = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(value)}`);
  return HostResponseSchema.parse(value);
}

async function measured(name: string, work: () => Promise<HostResponse>): Promise<HostResponse> {
  const time = Date.now();
  const result = await work();
  cases.push({ name, kind: result.kind, elapsed_ms: Date.now() - time });
  if (result.kind === 'error') throw new Error(`${name} failed: ${result.code} ${result.message}`);
  return result;
}

async function verifySharedView(conversationId: string, locale: 'en' | 'es', finalTurn: Extract<HostResponse, { kind: 'turn' }>['turn']) {
  const snapshotResponse = await fetch(`${base}/api/host/conversations/${conversationId}/tv`);
  assert.equal(snapshotResponse.status, 200, 'the completed conversation should expose a read-only public TV snapshot.');
  const snapshot = HostPublicStateSchema.parse(await snapshotResponse.json());
  assert.equal(snapshot.locale, locale);
  assert.equal(snapshot.turn?.phase, 'ended');
  assert.equal(snapshot.turn?.revision, finalTurn.revision);
  assert.equal(snapshot.turns.at(-1)?.revision, finalTurn.revision);
  const comicResponse = await fetch(`${base}/api/host/conversations/${conversationId}/comic.svg`);
  assert.equal(comicResponse.status, 200, 'the played public history should export as an SVG comic.');
  assert.match(comicResponse.headers.get('content-type') ?? '', /image\/svg\+xml/);
  assert.match(await comicResponse.text(), /<svg/);
  const events = await fetch(`${base}/api/host/conversations/${conversationId}/events`);
  assert.equal(events.status, 200);
  const reader = events.body?.getReader();
  assert.ok(reader);
  const initialEvent = await reader.read();
  assert.match(new TextDecoder().decode(initialEvent.value), /event: public-state/);
  await reader.cancel();
  return { public_history_turns: snapshot.turns.length, comic_svg: true, sse_snapshot: true };
}

async function finishAdventure(
  locale: 'en' | 'es',
  conversationId: string,
  initialTurn: Extract<HostResponse, { kind: 'turn' }>['turn'],
) {
  let turn = initialTurn;
  for (let step = 1; turn.phase !== 'ended' && step <= 12; step++) {
    const revision = turn.revision;
    const pendingCheck = turn.phase === 'awaiting_check' ? turn.pending_check : null;
    const choice = turn.phase === 'awaiting_choice' ? turn.choices[0] : undefined;
    if (!pendingCheck && !choice) throw new Error(`The ${locale} adventure cannot continue from phase ${turn.phase}.`);
    let response: HostResponse | undefined;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const requestText = pendingCheck
        ? locale === 'es' ? 'Resuelve ahora la tirada d20 pendiente y comunica el resultado oficial.' : 'Resolve the pending d20 check now and report its official result.'
        : locale === 'es'
          ? `Elegimos explícitamente la primera opción ahora: ${choice!.label}. Aplica esa decisión a la partida.`
          : `We explicitly choose the first option now: ${choice!.label}. Apply that decision to the game.`;
      response = await measured(`${pendingCheck ? 'resolve_check' : 'choose_next'}_${locale}_${step}${attempt === 2 ? '_retry' : ''}`, () => post(`/api/host/conversations/${conversationId}/turns`, {
        request_id: randomUUID(), text: attempt === 1 ? requestText : `${requestText} Do not just repeat the current turn; carry out the requested choice or check.`, expected_revision: revision,
      }));
      if (response.kind !== 'turn' || response.turn.revision !== revision) break;
    }
    if (!response) throw new Error(`The ${locale} host returned no response to the explicit player action.`);
    if (response.kind !== 'turn') {
      const details = 'question' in response ? response.question : 'message' in response ? response.message : 'assistant_text' in response ? response.assistant_text : response.kind;
      throw new Error(`The ${locale} host did not return a public turn for the explicit ${pendingCheck ? 'check' : 'choice'} (kind ${response.kind}): ${details}`);
    }
    if (response.turn.revision !== revision + 1) {
      const details = response.assistant_text;
      throw new Error(`The ${locale} host did not commit the explicit ${pendingCheck ? 'check' : 'choice'} after one retry (phase ${response.turn.phase}, revision ${response.turn.revision}/${revision + 1}): ${details ?? '(no explanation)'}`);
    }
    assert.equal(response.turn.session_id, initialTurn.session_id);
    turn = response.turn;
  }
  assert.equal(turn.phase, 'ended', `The ${locale} path did not reach an authored ending within 12 actions.`);
  return turn;
}

let reportPath = '';
try {
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve); server.once('error', reject);
  });
  const conversationId = randomUUID();
  await measured('create_conversation', () => post('/api/host/conversations', { request_id: conversationId, locale: 'en' }));
  const listed = await measured('list_and_explain_adventures', () => post(`/api/host/conversations/${conversationId}/turns`, {
    request_id: randomUUID(), text: 'Please list the available English adventures. The players are Ada and Bo. Ask us to choose; do not start yet.',
  }));
  assert.equal(listed.kind, 'message', 'The host should offer choices before starting.');
  const record = await host.store.get(conversationId);
  const selectedId = record.offered_adventure_ids[0];
  assert.ok(selectedId, 'The model must offer at least one adventure from the MCP catalogue.');
  const selected = record.catalogue.find(adventure => adventure.id === selectedId);
  assert.ok(selected);
  const started = await measured('player_selects_and_starts', () => post(`/api/host/conversations/${conversationId}/turns`, {
    request_id: randomUUID(), text: `We choose ${selected.title}. Start it for Ada and Bo.`,
  }));
  assert.equal(started.kind, 'turn', 'Selecting an offered adventure should create a public game turn.');
  if (started.kind !== 'turn') throw new Error('The host did not return a started public turn.');
  assert.equal(started.turn.locale, 'en');
  assert.equal(started.turn.revision, 1);
  assert.equal(started.conversation.session_id, started.turn.session_id);

  const queried = await measured('read_without_advancing', () => post(`/api/host/conversations/${conversationId}/turns`, {
    request_id: randomUUID(), text: 'Remind us what choices we have. Do not choose for us.', expected_revision: 1,
  }));
  assert.ok(queried.kind === 'message' || queried.kind === 'turn');
  const afterRead = await host.store.get(conversationId);
  assert.equal(afterRead.turn?.revision, 1, 'A readback must not advance the game.');

  assert.ok(started.turn.choices.length > 0, 'A newly started adventure must expose at least one choice.');
  const selectedChoice = started.turn.choices[0]!;
  const action = await measured('player_chooses_option_one', () => post(`/api/host/conversations/${conversationId}/turns`, {
    request_id: randomUUID(), text: `We choose option 1: ${selectedChoice.label}.`, expected_revision: 1,
  }));
  assert.equal(action.kind, 'turn', 'A clear choice should return the authoritative turn.');
  if (action.kind !== 'turn') throw new Error('The host did not return a turn after the choice.');
  assert.equal(action.turn.revision, 2, 'One player choice should commit at most one game revision.');
  const endedEn = await finishAdventure('en', conversationId, action.turn);
  const sharedEn = await verifySharedView(conversationId, 'en', endedEn);

  const spanishConversationId = randomUUID();
  await measured('create_conversation_es', () => post('/api/host/conversations', { request_id: spanishConversationId, locale: 'es' }));
  const listedEs = await measured('list_adventures_es', () => post(`/api/host/conversations/${spanishConversationId}/turns`, {
    request_id: randomUUID(), text: 'Muéstranos las aventuras en español. Somos Ada y Bo; queremos elegir antes de empezar.',
  }));
  assert.equal(listedEs.kind, 'message', 'The Spanish host should offer adventures before starting.');
  const spanishRecord = await host.store.get(spanishConversationId);
  const selectedEsId = spanishRecord.offered_adventure_ids[0];
  assert.ok(selectedEsId, 'The Spanish host must offer an adventure from the MCP catalogue.');
  const selectedEs = spanishRecord.catalogue.find(adventure => adventure.id === selectedEsId);
  assert.ok(selectedEs);
  const startedEs = await measured('player_selects_and_starts_es', () => post(`/api/host/conversations/${spanishConversationId}/turns`, {
    request_id: randomUUID(), text: `Elegimos ${selectedEs.title}. Empiézala para Ada y Bo.`,
  }));
  assert.equal(startedEs.kind, 'turn', 'The Spanish selection should start the offered adventure.');
  if (startedEs.kind !== 'turn') throw new Error('The Spanish host did not return an initial public turn.');
  assert.equal(startedEs.turn.locale, 'es');
  assert.equal(startedEs.turn.revision, 1);
  const choiceEs = startedEs.turn.choices[0];
  assert.ok(choiceEs, 'The Spanish adventure must expose a choice.');
  const actionEs = await measured('player_chooses_option_one_es', () => post(`/api/host/conversations/${spanishConversationId}/turns`, {
    request_id: randomUUID(), text: `Elegimos la opción 1: ${choiceEs.label}.`, expected_revision: 1,
  }));
  assert.equal(actionEs.kind, 'turn', 'The Spanish host should apply a clear player choice.');
  if (actionEs.kind !== 'turn') throw new Error('The Spanish host did not return a turn after the choice.');
  assert.equal(actionEs.turn.locale, 'es');
  assert.equal(actionEs.turn.revision, 2);
  const endedEs = await finishAdventure('es', spanishConversationId, actionEs.turn);
  const sharedEs = await verifySharedView(spanishConversationId, 'es', endedEs);

  const success = {
    model: config.ollamaModel,
    endpoint: '/mcp (Streamable HTTP; official MCP SDK)',
    scenarios: cases,
    completed_games: [
      { locale: 'en', phase: endedEn.phase, committed_revisions: endedEn.revision },
      { locale: 'es', phase: endedEs.phase, committed_revisions: endedEs.revision },
    ],
    shared_screen: { en: sharedEn, es: sharedEs },
    trace: trace.map(({ component, outcome, name, elapsed_ms, code }) => ({ component, outcome, ...(name ? { name } : {}), ...(elapsed_ms === undefined ? {} : { elapsed_ms }), ...(code ? { code } : {}) })),
    total_elapsed_ms: Date.now() - startedAt,
  };
  reportPath = path.join(reportDir, `v2-${new Date().toISOString().replaceAll(':', '-')}.json`);
  await writeFile(reportPath, JSON.stringify(success, null, 2), 'utf8');
  console.log(JSON.stringify({ ...success, report: reportPath }, null, 2));
} catch (error) {
  const failure = {
    model: config.ollamaModel,
    scenarios: cases,
    trace: trace.map(({ component, outcome, name, elapsed_ms, code }) => ({ component, outcome, ...(name ? { name } : {}), ...(elapsed_ms === undefined ? {} : { elapsed_ms }), ...(code ? { code } : {}) })),
    error: error instanceof Error ? error.message : 'Unknown live probe error',
    total_elapsed_ms: Date.now() - startedAt,
  };
  reportPath = path.join(reportDir, `v2-${new Date().toISOString().replaceAll(':', '-')}.json`);
  await writeFile(reportPath, JSON.stringify(failure, null, 2), 'utf8');
  console.error(JSON.stringify({ ...failure, report: reportPath }, null, 2));
  process.exitCode = 1;
} finally {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await host.close();
  await rm(dataDir, { recursive: true, force: true });
}
