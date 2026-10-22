import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicTurnSchema, type PublicTurn } from '../shared/session-schema.js';
import { assertLocalHttpUrl } from '../mcp-server/llm/ollama.js';
import { toOllamaTools, type DiscoveredMcpTool } from '../mcp-server/host/mcp-gateway.js';
import { hasExplicitCheckIntent, hasExplicitCloseIntent, playerSelectedAdventure, redactSecrets, resolveExplicitPlayerChoice, resolvePlayerAdventureSelection, validateInteractionAgainstTurn } from '../mcp-server/host/service.js';
import type { AdventureSummary } from '../shared/host-schema.js';

const adventure = (id: string, title: string): AdventureSummary => ({
  id, version: 1, title, locale: 'en', genre: 'mystery', tone: 'hopeful', duration_minutes: 20,
  players: { min: 1, max: 4 }, objective: 'Find the missing bell.',
});

test('adventure selection accepts explicit and unambiguous references only to offered items', () => {
  const first = adventure('bell-tower', 'The Bell Tower');
  const second = adventure('glass-harbor', 'Glass Harbor');
  const catalogue = [first, second];
  assert.equal(playerSelectedAdventure(first, ['bell-tower', 'glass-harbor'], 'Let us play The Bell Tower.', catalogue), true);
  assert.equal(playerSelectedAdventure(second, ['bell-tower', 'glass-harbor'], 'Choose option 2.', catalogue), true);
  assert.equal(playerSelectedAdventure(first, ['bell-tower'], 'Yes, that one.', catalogue), true);
  assert.equal(playerSelectedAdventure(first, ['bell-tower', 'glass-harbor'], 'Yes, that one.', catalogue), false);
  assert.equal(playerSelectedAdventure(second, ['bell-tower'], 'Let us play Glass Harbor.', catalogue), false);
  assert.equal(resolvePlayerAdventureSelection(['bell-tower'], 'Let us play The Bell Tower.', catalogue)?.id, 'bell-tower');
  assert.equal(resolvePlayerAdventureSelection(['bell-tower'], 'Let us play Glass Harbor.', catalogue), undefined);
});

test('closing requires explicit intent and rejects incidental or negated mentions', () => {
  for (const text of ['Please end the session.', 'Can we finish this adventure?', 'Quiero cerrar la partida.']) {
    assert.equal(hasExplicitCloseIntent(text), true, text);
  }
  for (const text of [
    'I need to stop by the old bridge.', 'I got to the end of the game.',
    "I don't want to end the game yet.", 'No quiero cerrar la partida todavía.',
  ]) assert.equal(hasExplicitCloseIntent(text), false, text);
});

function publicTurn(): PublicTurn {
  return PublicTurnSchema.parse({
    schema_version: 2, session_id: '11111111-1111-4111-8111-111111111111', locale: 'en', revision: 3, view_revision: 3,
    phase: 'awaiting_choice', scene_id: 'room', narration: 'A stone door stands ahead.',
    choices: [{ id: 'open-door', label: 'Open the stone door' }],
    affordances: [{
      id: 'inspect-door', resolution_choice_id: 'open-door', label: 'Inspect the door', summary: 'Look for a safe way to open it.',
      targets: [{ id: 'stone-door', label: 'Stone door' }], item_ids: ['brass-key'], approaches: [{ id: 'turn-key', label: 'Turn the key' }],
    }],
    pending_check: null, recent_outcome: null, inventory: [{ id: 'brass-key', name: 'Brass key', description: 'A small brass key.' }],
    recap: '', next_expected_input: 'Choose an option.', visual_status: 'ready',
  });
}

test('MCP-discovered tools retain public input constraints and hide host-owned linkage fields', () => {
  const tools: DiscoveredMcpTool[] = [{
    name: 'submit_action', description: 'Submit action', inputSchema: {
      type: 'object', properties: {
        session_id: { type: 'string' }, expected_revision: { type: 'integer', minimum: 0 }, request_id: { type: 'string', format: 'uuid' },
        interaction: { oneOf: [{ type: 'object', required: ['kind', 'choice_id'] }, { type: 'object', required: ['kind', 'affordance_id'] }] },
      }, required: ['session_id', 'expected_revision', 'request_id', 'interaction'], additionalProperties: false,
    },
  }];
  const [tool] = toOllamaTools(tools);
  assert.ok(tool);
  assert.deepEqual(Object.keys(tool.function.parameters.properties as object), ['interaction']);
  assert.deepEqual(tool.function.parameters.required, ['interaction']);
  assert.equal(tool.function.parameters.additionalProperties, false);
  assert.equal((tool.function.parameters.properties as Record<string, { oneOf: unknown[] }>).interaction.oneOf.length, 2);
});

test('free actions and choices are checked against the current public turn', () => {
  const turn = publicTurn();
  assert.deepEqual(validateInteractionAgainstTurn(turn, { kind: 'choice', choice_id: 'open-door', action_text: 'Go ahead' }, 'Let us open the door.'), {
    ok: true, interaction: { kind: 'choice', choice_id: 'open-door', action_text: 'Let us open the door.' },
  });
  const allowed = validateInteractionAgainstTurn(turn, {
    kind: 'free_action', affordance_id: 'inspect-door', target_id: 'stone-door', item_id: 'brass-key', approach_id: 'turn-key', action_text: 'I try the key.',
  }, 'I try the key.');
  assert.equal(allowed.ok, true);
  const forgedChoice = validateInteractionAgainstTurn(turn, { kind: 'choice', choice_id: 'invented-ending', action_text: 'Win' }, 'Win');
  assert.equal(forgedChoice.ok, false);
  const forgedTarget = validateInteractionAgainstTurn(turn, {
    kind: 'free_action', affordance_id: 'inspect-door', target_id: 'secret-door', approach_id: 'turn-key', item_id: 'brass-key', action_text: 'Try it',
  }, 'Try it');
  assert.equal(forgedTarget.ok, false);
  const forgedItem = validateInteractionAgainstTurn(turn, {
    kind: 'free_action', affordance_id: 'inspect-door', target_id: 'stone-door', approach_id: 'turn-key', item_id: 'crown', action_text: 'Try it',
  }, 'Try it');
  assert.equal(forgedItem.ok, false);
  assert.equal(validateInteractionAgainstTurn({ ...turn, phase: 'awaiting_check', choices: [], pending_check: { id: 'check-x', kind: 'd20', difficulty_class: 11, prompt: 'Test' } }, { kind: 'choice', choice_id: 'open-door', action_text: 'Open' }, 'Open').ok, false);
});

test('only a clear, affirmative numbered or exact-label choice is resolved without model interpretation', () => {
  const turn = publicTurn();
  assert.equal(resolveExplicitPlayerChoice(turn, 'We explicitly choose the first option now: Open the stone door.')?.id, 'open-door');
  assert.equal(resolveExplicitPlayerChoice(turn, 'Choose option 1: Open the stone door.')?.id, 'open-door');
  assert.equal(resolveExplicitPlayerChoice(turn, 'Should we choose option 1?'), undefined);
  assert.equal(resolveExplicitPlayerChoice(turn, 'We do not choose option 1.'), undefined);
  assert.equal(resolveExplicitPlayerChoice(turn, 'We choose option 2.'), undefined);
  assert.equal(resolveExplicitPlayerChoice(turn, 'We choose: Open the stone door.')?.id, 'open-door');
  assert.equal(resolveExplicitPlayerChoice(turn, 'We choose: Open the stone door or do something else.'), undefined);
  assert.equal(resolveExplicitPlayerChoice(turn, 'We do not choose: Open the stone door.'), undefined);
  const spanish = { ...turn, locale: 'es' as const, choices: [{ id: 'ask-elin', label: 'Preguntar a Elin qué necesita el pueblo' }] };
  assert.equal(resolveExplicitPlayerChoice(spanish, 'Elegimos: Preguntar a Elin qué necesita el pueblo.')?.id, 'ask-elin');
  assert.equal(resolveExplicitPlayerChoice(spanish, '¿Elegimos: Preguntar a Elin qué necesita el pueblo?'), undefined);
  assert.equal(resolveExplicitPlayerChoice(spanish, 'No elegimos: Preguntar a Elin qué necesita el pueblo.'), undefined);
  assert.equal(resolveExplicitPlayerChoice({ ...spanish, choices: [...spanish.choices, { id: 'duplicate', label: spanish.choices[0]!.label }] }, 'Elegimos: Preguntar a Elin qué necesita el pueblo.'), undefined);
  assert.equal(resolveExplicitPlayerChoice({ ...turn, locale: 'es' }, 'Elegimos explícitamente la primera opción: Abrir la puerta de piedra.' )?.id, 'open-door');
});

test('a pending check is directly resolved only when the player explicitly asks to roll it', () => {
  const turn = { ...publicTurn(), phase: 'awaiting_check' as const, choices: [], pending_check: { id: 'check-1', kind: 'd20' as const, difficulty_class: 12, prompt: 'Roll to cross the bridge.' } };
  assert.equal(hasExplicitCheckIntent(turn, 'Resolve the pending d20 check now.'), true);
  assert.equal(hasExplicitCheckIntent(turn, 'Resuelve ahora la tirada pendiente.'), true);
  assert.equal(hasExplicitCheckIntent(turn, 'Should we resolve this check?'), false);
  assert.equal(hasExplicitCheckIntent(turn, 'Do not resolve this check yet.'), false);
  assert.equal(hasExplicitCheckIntent(turn, 'Tiramos el dado.'), true);
  assert.equal(hasExplicitCheckIntent(turn, 'Roll the dice.'), true);
  assert.equal(hasExplicitCheckIntent(turn, '¿Tiramos el dado?'), false);
  assert.equal(hasExplicitCheckIntent(turn, 'No tiramos el dado.'), false);
  assert.equal(hasExplicitCheckIntent({ ...turn, phase: 'awaiting_choice', pending_check: null }, 'Tiramos el dado.'), false);
});

test('local provider URL and secret redaction have fail-closed defaults', () => {
  assert.equal(assertLocalHttpUrl('http://localhost:11434/api', 'OLLAMA_BASE_URL'), 'http://localhost:11434');
  assert.throws(() => assertLocalHttpUrl('https://ollama.example/api', 'OLLAMA_BASE_URL'), /loopback/);
  const cleaned = redactSecrets('Use AKIA1234567890ABCDEF and Bearer abcdefghijklmnop1234; api_key=supersecret123');
  assert.doesNotMatch(cleaned, /AKIA1234567890ABCDEF|abcdefghijklmnop1234|supersecret123/);
});
