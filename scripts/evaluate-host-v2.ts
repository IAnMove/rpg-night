import 'dotenv/config';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { createApp, errorHandler } from '../mcp-server/app.js';
import { readConfig } from '../mcp-server/config.js';
import { Game } from '../mcp-server/game.js';
import { ConversationHost } from '../mcp-server/host/service.js';
import { McpGateway } from '../mcp-server/host/mcp-gateway.js';
import { OllamaClient } from '../mcp-server/llm/ollama.js';
import type { HostResponse } from '../shared/host-schema.js';
import type { PublicTurn } from '../shared/session-schema.js';

type Locale = 'en' | 'es';
type CapturedCall = { name: string; args: Record<string, unknown>; failed: boolean };
type CapturedModelCall = { tools: Array<{ name: string; args: Record<string, unknown> }> };
type CaseResult = {
  locale: Locale;
  scenario: string;
  passed: boolean;
  elapsed_ms: number;
  calls: CapturedCall[];
  model_calls: CapturedModelCall[];
  evidence?: Record<string, unknown>;
  error?: string;
};

const port = Number(process.env.HOST_EVAL_PORT ?? 3104);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535, 'HOST_EVAL_PORT must be an available high port.');
const dataDir = await mkdtemp(path.join(os.tmpdir(), 'rpg-night-host-eval-'));
const reportDir = path.resolve('.work', 'review');
await mkdir(reportDir, { recursive: true });
const config = readConfig({
  ...process.env,
  PORT: String(port), HOST: '127.0.0.1', DATA_DIR: dataDir, HOST_MODE: 'ollama',
  RPG_MCP_URL: `http://127.0.0.1:${port}/mcp`,
});
const calls: CapturedCall[] = [];
const modelCalls: CapturedModelCall[] = [];
const results: CaseResult[] = [];
let game: Game;
let host: ConversationHost;
let server: Server | undefined;

function safeArgs(name: string, args: Record<string, unknown>): Record<string, unknown> {
  if (name === 'list_adventures') {
    return Object.fromEntries(['locale', 'genre', 'players', 'duration_minutes'].flatMap(key => key in args ? [[key, args[key]]] : []));
  }
  if (name === 'start_session') return { adventure_id: args.adventure_id, player_count: Array.isArray(args.players) ? args.players.length : null };
  if (name === 'submit_action') {
    const interaction = args.interaction && typeof args.interaction === 'object' ? args.interaction as Record<string, unknown> : args;
    return Object.fromEntries(['kind', 'choice_id', 'affordance_id', 'target_id', 'item_id', 'approach_id'].flatMap(key => key in interaction ? [[key, interaction[key]]] : []));
  }
  if (name === 'prepare_adventure') {
    const preferences = args.preferences && typeof args.preferences === 'object' ? args.preferences as Record<string, unknown> : {};
    return { locale: args.locale, premise_length: typeof args.premise === 'string' ? args.premise.length : 0, preference_keys: Object.keys(preferences).sort() };
  }
  return {};
}

function safeModelArgs(name: string, args: unknown): Record<string, unknown> {
  const value = args && typeof args === 'object' && !Array.isArray(args) ? args as Record<string, unknown> : {};
  if (['submit_action', 'list_adventures', 'start_session', 'prepare_adventure'].includes(name)) return safeArgs(name, value);
  return {};
}

function createHost(): ConversationHost {
  const ollama = new OllamaClient({ baseUrl: config.ollamaBaseUrl, model: config.ollamaModel });
  const originalChat = ollama.chat.bind(ollama);
  ollama.chat = async options => {
    const response = await originalChat(options);
    modelCalls.push({ tools: response.tool_calls.map(call => ({ name: call.name, args: safeModelArgs(call.name, call.arguments) })) });
    return response;
  };
  const instance = new ConversationHost({
    dataDir,
    ollama,
    mcp: new McpGateway({ url: config.mcpUrl }),
    trace: () => undefined,
  });
  const originalCall = instance.mcp.call.bind(instance.mcp);
  instance.mcp.call = async (name, args, signal) => {
    try {
      const result = await originalCall(name, args, signal);
      calls.push({ name, args: safeArgs(name, args), failed: Boolean(result.isError) });
      return result;
    } catch (error) {
      calls.push({ name, args: safeArgs(name, args), failed: true });
      throw error;
    }
  };
  return instance;
}

async function startServer() {
  game = new Game(config);
  await game.init();
  host = createHost();
  const app = createApp(config, game, undefined, host);
  app.use(errorHandler);
  await new Promise<void>((resolve, reject) => {
    server = app.listen(config.port, config.host, error => error ? reject(error) : resolve());
    server.once('error', reject);
  });
}

async function stopServer() {
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server!.close(error => error ? reject(error) : resolve()));
    server = undefined;
  }
  if (host) await host.close();
}

async function restartServer() {
  await stopServer();
  await startServer();
}

function getTurn(response: HostResponse): PublicTurn {
  if (response.kind === 'error') throw new Error(`Host returned ${response.code}.`);
  assert.equal(response.kind, 'turn', 'Expected an authoritative public turn.');
  if (response.kind !== 'turn') throw new Error('Expected a public turn.');
  return response.turn;
}

function assertNoMutation(caseCalls: CapturedCall[], before: number, after: number) {
  assert.equal(after, before, 'A read or clarification must preserve the narrative revision.');
  assert.equal(caseCalls.some(call => ['start_session', 'submit_action', 'resolve_check', 'end_session'].includes(call.name)), false, 'A read or clarification must not call a game mutation.');
}

async function evaluated(locale: Locale, scenario: string, action: () => Promise<Record<string, unknown>>) {
  const started = Date.now();
  const callOffset = calls.length;
  const modelCallOffset = modelCalls.length;
  try {
    const evidence = await action();
    results.push({ locale, scenario, passed: true, elapsed_ms: Date.now() - started, calls: calls.slice(callOffset), model_calls: modelCalls.slice(modelCallOffset), evidence });
    return evidence;
  } catch (error) {
    results.push({
      locale, scenario, passed: false, elapsed_ms: Date.now() - started, calls: calls.slice(callOffset), model_calls: modelCalls.slice(modelCallOffset),
      error: error instanceof Error ? error.message.slice(0, 240) : 'evaluation_failed',
    });
    throw error;
  }
}

function turnRequest(text: string, revision?: number) {
  return { request_id: randomUUID(), text, ...(revision === undefined ? {} : { expected_revision: revision }) };
}

async function runLanguage(locale: Locale) {
  const title = locale === 'en' ? 'The Bell Beneath Elderglen' : 'La campana bajo Elderglen';
  const names = locale === 'en' ? ['Ada', 'Bo'] : ['Ada', 'Bo'];
  const created = await host.createConversation({ request_id: randomUUID(), locale });
  assert.equal(created.kind, 'message');
  if (created.kind !== 'message') throw new Error(`Could not create ${locale} conversation.`);
  const conversationId = created.conversation.conversation_id;
  let turn!: PublicTurn;

  await evaluated(locale, 'find_filter_and_start_authored_adventure', async () => {
    const caseCallOffset = calls.length;
    const requestText = locale === 'en'
      ? 'Find a cozy mystery for two players that takes no more than 20 minutes. List a suitable written adventure and ask us to choose; Ada and Bo are playing. Do not start it yet.'
      : 'Busca un misterio acogedor para dos jugadores que dure como máximo 20 minutos. Lista una aventura escrita adecuada y pregúntanos cuál elegir; jugamos Ada y Bo. No la empieces todavía.';
    const listed = await host.turn(conversationId, turnRequest(requestText));
    assert.equal(listed.kind, 'message', 'Listing adventures must not start the game.');
    const beforeStart = await host.store.get(conversationId);
    assert.equal(beforeStart.session_id, null, 'The host must wait for an explicit player selection.');
    const listCall = calls.slice(caseCallOffset).find(call => call.name === 'list_adventures' && !call.failed);
    assert.ok(listCall, 'The host must use the real MCP adventure catalogue.');
    assert.equal(listCall.args.players, 2, 'The requested party-size filter must reach MCP.');
    assert.ok(Number(listCall.args.duration_minutes) <= 20, 'The requested duration filter must reach MCP.');
    const genre = String(listCall.args.genre ?? '').toLocaleLowerCase();
    assert.ok(locale === 'en' ? /cozy|mystery/.test(genre) : /misterio|acogedor|mystery/.test(genre), 'The requested genre filter must reach MCP.');
    const offered = beforeStart.catalogue.find(adventure => beforeStart.offered_adventure_ids.includes(adventure.id));
    assert.ok(offered && offered.title === title, 'The host should offer the matching authored adventure.');
    const selected = await host.turn(conversationId, turnRequest(locale === 'en'
      ? `We choose ${title}. Start it for Ada and Bo.`
      : `Elegimos ${title}. Empiézala para Ada y Bo.`));
    turn = getTurn(selected);
    assert.equal(turn.revision, 1);
    assert.equal(turn.scene_id, 'arrival');
    assert.equal(turn.phase, 'awaiting_choice');
    const latest = await host.store.get(conversationId);
    assert.deepEqual(latest.player_names, names);
    assert.equal(calls.slice(caseCallOffset).filter(call => call.name === 'start_session' && !call.failed).length, 1, 'The selected adventure must start exactly once.');
    return { list_filter: { genre, players: listCall.args.players, duration_minutes: listCall.args.duration_minutes }, started: true, revision: turn.revision, phase: turn.phase };
  });

  await evaluated(locale, 'choose_by_number', async () => {
    const caseCallOffset = calls.length;
    const before = turn.revision;
    const chosen = await host.turn(conversationId, turnRequest(locale === 'en'
      ? 'We explicitly choose option 1 now. Apply only that choice.'
      : 'Elegimos explícitamente la opción 1 ahora. Aplica solo esa opción.', before));
    turn = getTurn(chosen);
    assert.equal(turn.scene_id, 'green');
    assert.equal(turn.revision, before + 1);
    const applied = calls.slice(caseCallOffset).filter(call => call.name === 'submit_action' && !call.failed);
    assert.equal(applied.length, 1);
    assert.equal(applied[0]!.args.choice_id, 'visit-green');
    return { revision: turn.revision, scene_id: turn.scene_id, committed_choice: applied[0]!.args.choice_id };
  });

  await evaluated(locale, 'clarify_two_plausible_actions_without_advancing', async () => {
    const caseCallOffset = calls.length;
    const before = turn.revision;
    const ambiguous = await host.turn(conversationId, turnRequest(locale === 'en'
      ? 'We are split between talking with Warden Elin and helping Oren at the ferry. We have not chosen. Ask us one short question so we can decide; do not recommend or take either action.'
      : 'No nos ponemos de acuerdo entre hablar con la guardiana Elin y ayudar a Oren en el ferry. Aún no hemos elegido. Haznos una pregunta breve para que decidamos; no recomiendes ni hagas ninguna de las dos cosas.', before));
    assert.equal(ambiguous.kind, 'clarification', 'The host should ask the players to resolve the ambiguity.');
    if (ambiguous.kind !== 'clarification') throw new Error('The host did not return a clarification.');
    const responseTurn = ambiguous.turn;
    assert.equal(responseTurn.revision, before);
    assertNoMutation(calls.slice(caseCallOffset), before, responseTurn.revision);
    return { response_kind: ambiguous.kind, revision: responseTurn.revision };
  });

  await evaluated(locale, 'consult_inventory_without_advancing', async () => {
    const caseCallOffset = calls.length;
    const before = turn.revision;
    const reply = await host.turn(conversationId, turnRequest(locale === 'en'
      ? 'What items does our party currently carry? List the inventory and do not choose anything.'
      : '¿Qué objetos lleva ahora el grupo? Enumera el inventario y no elijas nada.', before));
    const responseTurn = reply.kind === 'turn' ? reply.turn : reply.kind === 'clarification' ? reply.turn : undefined;
    assert.ok(responseTurn, 'The inventory answer should preserve the public turn.');
    assert.equal(responseTurn.revision, before);
    assert.equal(responseTurn.inventory.length, 0);
    assertNoMutation(calls.slice(caseCallOffset), before, responseTurn.revision);
    return { revision: responseTurn.revision, inventory_count: responseTurn.inventory.length };
  });

  await evaluated(locale, 'repeat_objective_and_options_without_spoilers', async () => {
    const caseCallOffset = calls.length;
    const before = turn.revision;
    const reply = await host.turn(conversationId, turnRequest(locale === 'en'
      ? 'Remind us of the current objective and the choices currently on screen. No spoilers, and do not act for us.'
      : 'Recuérdanos el objetivo actual y las opciones que vemos ahora. Sin adelantos y no decidas por nosotros.', before));
    const responseTurn = reply.kind === 'turn' ? reply.turn : reply.kind === 'clarification' ? reply.turn : undefined;
    assert.ok(responseTurn);
    assert.equal(responseTurn.revision, before);
    assertNoMutation(calls.slice(caseCallOffset), before, responseTurn.revision);
    const responseText = reply.kind === 'turn' ? reply.assistant_text : reply.kind === 'clarification' ? reply.question : '';
    const leakedSecret = locale === 'en'
      ? responseText.includes("The bell's silence is caused by a jammed lantern mechanism")
      : responseText.includes('La campana calla porque el mecanismo de la linterna está atascado');
    assert.equal(leakedSecret, false, 'A private future clue must not be revealed.');
    assert.ok(responseTurn.choices.length > 0);
    return { revision: responseTurn.revision, choice_count: responseTurn.choices.length, private_secret_leaked: false };
  });

  await evaluated(locale, 'choose_with_a_paraphrase', async () => {
    const caseCallOffset = calls.length;
    const before = turn.revision;
    const paraphrase = await host.turn(conversationId, turnRequest(locale === 'en'
      ? 'Please talk with Warden Elin and hear what the neighbors need before we decide.'
      : 'Habla con la guardiana Elin y averigua qué necesita el vecindario antes de que decidamos.', before));
    turn = getTurn(paraphrase);
    assert.equal(turn.scene_id, 'lantern-room');
    assert.equal(turn.revision, before + 1);
    const action = calls.slice(caseCallOffset).find(call => call.name === 'submit_action' && !call.failed);
    assert.ok(action, 'The model must resolve the paraphrase into one current interaction.');
    assert.ok(action.args.choice_id === 'ask-warden' || action.args.affordance_id === 'speak-with-warden');
    return { revision: turn.revision, scene_id: turn.scene_id, resolved_intent: action.args.choice_id ?? action.args.affordance_id };
  });

  const transition = await host.turn(conversationId, turnRequest(locale === 'en'
    ? 'We explicitly choose option 1 to carry the message to the tower.'
    : 'Elegimos explícitamente la opción 1 para llevar el mensaje a la torre.', turn.revision));
  turn = getTurn(transition);
  assert.equal(turn.scene_id, 'bell-tower');

  await evaluated(locale, 'perform_contextual_free_interaction', async () => {
    const caseCallOffset = calls.length;
    const before = turn.revision;
    const interaction = await host.turn(conversationId, turnRequest(locale === 'en'
      ? 'I brace my feet and pull steadily on the release lever. We want to see if the mechanism yields.'
      : 'Afirmo los pies y tiro con firmeza de la palanca. Queremos comprobar si cede el mecanismo.', before));
    turn = getTurn(interaction);
    assert.equal(turn.scene_id, 'bell-tower');
    assert.equal(turn.phase, 'awaiting_check');
    assert.equal(turn.revision, before + 1);
    const action = calls.slice(caseCallOffset).find(call => call.name === 'submit_action' && !call.failed);
    assert.ok(action);
    assert.equal(action.args.kind, 'free_action', 'A free-form intent must be interpreted as a typed affordance interaction.');
    assert.equal(action.args.affordance_id, 'work-release-lever');
    assert.equal(action.args.target_id, 'release-lever');
    assert.equal(action.args.approach_id, 'steady-pull');
    return { revision: turn.revision, scene_id: turn.scene_id, phase: turn.phase, interaction: action.args };
  });

  await evaluated(locale, 'resolve_server_pending_d20_once', async () => {
    const caseCallOffset = calls.length;
    assert.equal(turn.phase, 'awaiting_check');
    const beforeCheck = turn.revision;
    const resolved = await host.turn(conversationId, turnRequest(locale === 'en'
      ? 'Resolve the pending d20 check now and tell us the official result.'
      : 'Resuelve ahora la tirada d20 pendiente y dinos el resultado oficial.', beforeCheck));
    turn = getTurn(resolved);
    assert.equal(turn.phase, 'awaiting_choice');
    assert.equal(turn.revision, beforeCheck + 1);
    assert.equal(turn.recent_outcome?.kind, 'check');
    if (turn.recent_outcome?.kind !== 'check') throw new Error('The game did not return a server check result.');
    assert.ok(turn.recent_outcome.total >= 1 && turn.recent_outcome.total <= 20);
    assert.ok(['success', 'setback'].includes(turn.recent_outcome.result));
    const resolutionCalls = calls.slice(caseCallOffset).filter(call => call.name === 'resolve_check' && !call.failed);
    assert.equal(resolutionCalls.length, 1, 'A pending check must be resolved exactly once.');
    return { revision: turn.revision, die: 'd20', total: turn.recent_outcome.total, result: turn.recent_outcome.result, resolution_count: resolutionCalls.length };
  });

  await evaluated(locale, 'pause_restart_resume_and_recap', async () => {
    const caseCallOffset = calls.length;
    const before = turn.revision;
    const paused = await host.pause(conversationId, { request_id: randomUUID(), expected_revision: before });
    assert.equal(paused.kind, 'turn');
    assert.equal(paused.conversation.paused, true);
    await restartServer();
    const resumed = await host.resume(conversationId, { request_id: randomUUID(), expected_revision: before });
    assert.equal(resumed.kind, 'turn');
    assert.equal(resumed.conversation.paused, false);
    turn = resumed.turn;
    assert.equal(turn.revision, before, 'Restart and resume must not invent a choice or reroll.');
    const recapCallOffset = calls.length;
    const recap = await host.turn(conversationId, turnRequest(locale === 'en'
      ? 'Remind us where we left off and present the available choices, but do not choose for us.'
      : 'Recuérdanos dónde lo dejamos y presenta las opciones disponibles, pero no elijas por nosotros.', before));
    const recapTurn = recap.kind === 'turn' ? recap.turn : undefined;
    assert.ok(recapTurn);
    assert.equal(recapTurn.revision, before);
    assertNoMutation(calls.slice(recapCallOffset), before, recapTurn.revision);
    turn = recapTurn;
    return { paused: true, restarted: true, resumed: true, revision: turn.revision, phase: turn.phase };
  });

  await evaluated(locale, 'prepare_and_poll_new_adventure_without_starting', async () => {
    const generatedConversation = await host.createConversation({ request_id: randomUUID(), locale });
    assert.equal(generatedConversation.kind, 'message');
    if (generatedConversation.kind !== 'message') throw new Error('Could not create a preparation conversation.');
    const generationConversationId = generatedConversation.conversation.conversation_id;
    const premise = locale === 'en'
      ? 'Create a short cozy mystery about a missing lighthouse lens before a storm, for two named players, with gentle peril and no graphic violence.'
      : 'Crea un misterio acogedor y breve sobre una lente de faro desaparecida antes de una tormenta, para dos jugadores, con peligro leve y sin violencia gráfica.';
    let operation = await host.turn(generationConversationId, turnRequest(premise));
    assert.equal(operation.kind, 'operation');
    let polls = 0;
    while (operation.kind === 'operation' && operation.operation.status === 'pending' && polls < 90) {
      await new Promise(resolve => setTimeout(resolve, 1000));
      operation = await host.getPendingOperation(generationConversationId);
      polls++;
    }
    assert.equal(operation.kind, 'operation');
    if (operation.kind !== 'operation') throw new Error('Preparation returned no operation result.');
    const prepared = operation.operation;
    if (!('result' in prepared) || prepared.status !== 'ready') throw new Error('A generated story did not validate before the polling deadline.');
    assert.equal(prepared.kind, 'prepare_adventure');
    if (prepared.result.kind !== 'adventure') throw new Error('The ready operation did not contain a public adventure.');
    const generatedId = prepared.result.adventure_id;
    const persisted = await host.store.get(generationConversationId);
    assert.equal(persisted.session_id, null, 'Preparing a story must not start it automatically.');
    assert.ok(persisted.catalogue.some(adventure => adventure.id === generatedId && adventure.locale === locale));
    return { operation_status: 'ready', generated_locale: locale, listed: true, started_automatically: false, polls };
  });
}

const startedAt = Date.now();
let failure: string | undefined;
try {
  await startServer();
  await runLanguage('en');
  await runLanguage('es');
} catch (error) {
  failure = error instanceof Error ? error.message.slice(0, 240) : 'evaluation_failed';
} finally {
  await stopServer().catch(() => undefined);
  await rm(dataDir, { recursive: true, force: true });
}

const report = {
  timestamp: new Date().toISOString(),
  model: config.ollamaModel,
  host: 'local Ollama → ConversationHost → official MCP SDK over Streamable HTTP → authoritative game service',
  scenarios: results,
  summary: { passed: results.filter(result => result.passed).length, failed: results.filter(result => !result.passed).length, total: 20, completed: results.length === 20, elapsed_ms: Date.now() - startedAt },
  ...(failure ? { failure } : {}),
  human_narration_review: 'pending; the report deliberately stores no transcripts',
};
const reportPath = path.join(reportDir, `host-v2-evaluation-${new Date().toISOString().replaceAll(':', '-')}.json`);
await writeFile(reportPath, JSON.stringify(report, null, 2), 'utf8');
console.log(JSON.stringify({ ...report, report: reportPath }, null, 2));
if (failure || results.length !== 20 || results.some(result => !result.passed)) process.exitCode = 1;
