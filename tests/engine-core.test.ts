import test from 'node:test';
import assert from 'node:assert/strict';
import minimalAdventure from '../shared/fixtures/adventures/valid-minimal.json' with { type: 'json' };
import {
  createInitialSession,
  endSession,
  EngineError,
  getPublicTurn,
  resolvePendingCheck,
  submitInteraction,
} from '../mcp-server/engine/core.js';
import { PersistedSessionV2Schema, type PersistedSessionV2 } from '../shared/session-schema.js';

const sessionId = '11111111-1111-4111-8111-111111111111';
const requestId = '22222222-2222-4222-8222-222222222222';
const nextRequestId = '33333333-3333-4333-8333-333333333333';
const fixedNow = '2026-10-22T10:00:00.000Z';

function makeAdventure(): Record<string, any> {
  const adventure = structuredClone(minimalAdventure) as Record<string, any>;
  adventure.items = [{ id: 'brass-key', name: 'Brass key', description: 'A small, worn key.' }];
  adventure.variables = { trust: { initial: 0, min: 0, max: 2 } };
  const opening = adventure.nodes[0];
  opening.secrets = ['The keeper is secretly a dragon.'];
  opening.choices[0].conditions = [{ kind: 'variable', variable_id: 'trust', operator: 'gte', value: 1 }];
  opening.choices[0].effects = [{ kind: 'add_item', item_id: 'brass-key' }];
  opening.choices[1].transition = {
    kind: 'check', sides: 20, difficulty_class: 12,
    success_node_id: 'left-ending', setback_node_id: 'right-ending',
    success_effects: [{ kind: 'increment_variable', variable_id: 'trust', amount: 1 }],
    setback_effects: [{ kind: 'set_variable', variable_id: 'trust', value: 0 }],
  };
  opening.choices.push({
    id: 'fallback-path', label: 'Take the safe path', action: 'Take the safe path',
    conditions: [], effects: [], transition: { kind: 'direct', target_node_id: 'right-ending' },
  });
  opening.affordances = [{
    id: 'talk-to-keeper', resolution_choice_id: 'left-path', label: 'Talk to the keeper',
    summary: 'Ask the keeper about the way forward.',
    targets: [{ id: 'keeper', label: 'keeper' }, { id: 'door', label: 'door' }],
    item_ids: ['brass-key'],
    approaches: [{ id: 'polite', label: 'ask politely' }, { id: 'threaten', label: 'threaten' }],
  }];
  return adventure;
}

function start(adventure = makeAdventure()) {
  return createInitialSession(adventure, { sessionId, requestId, players: ['Mira', 'Leo'] }, {
    now: () => fixedNow,
    createId: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  });
}

function withSession(session: PersistedSessionV2, patch: Partial<PersistedSessionV2>): PersistedSessionV2 {
  return PersistedSessionV2Schema.parse({ ...session, ...patch });
}

function assertEngineError(fn: () => unknown, code: string) {
  assert.throws(fn, (error: unknown) => error instanceof EngineError && error.code === code);
}

test('initial turn exposes only current public content and filters unavailable choices', () => {
  const adventure = makeAdventure();
  const result = start(adventure);

  assert.equal(result.turn.phase, 'awaiting_choice');
  assert.deepEqual(result.turn.choices.map(({ id }) => id), ['right-path', 'fallback-path']);
  assert.equal(result.turn.scene_id, 'opening');
  assert.deepEqual(result.turn.affordances, [], 'an affordance must not point at a conditionally unavailable choice');
  assert.equal(JSON.stringify(result.turn).includes('secretly a dragon'), false);
  assert.equal(JSON.stringify(result.turn).includes('left-ending'), false);
  assert.equal(JSON.stringify(result.turn).includes('trust'), false);

  const eligible = withSession(result.session, { variables: { trust: 1 } });
  const eligibleTurn = getPublicTurn(adventure, eligible);
  assert.deepEqual(eligibleTurn.choices.map(({ id }) => id), ['left-path', 'right-path', 'fallback-path']);
  assert.deepEqual(eligibleTurn.affordances[0]?.item_ids, [], 'only currently owned items are exposed as usable');
});

test('a valid direct action applies bounded effects and produces one authoritative ending', () => {
  const adventure = makeAdventure();
  const initial = start(adventure);
  const session = withSession(initial.session, { variables: { trust: 1 } });
  const result = submitInteraction(adventure, session, {
    kind: 'choice', choice_id: 'left-path', action_text: 'We ask for the key.',
  }, { requestId: nextRequestId }, { now: () => fixedNow });

  assert.equal(result.session.current_node_id, 'left-ending');
  assert.equal(result.session.phase, 'ended');
  assert.deepEqual(result.session.inventory, ['brass-key']);
  assert.equal(result.session.revision, 2);
  assert.equal(result.session.view_revision, 2);
  assert.equal(result.turn.phase, 'ended');
  assert.deepEqual(result.turn.choices, []);
  assert.equal(result.session.event_log.at(-1)?.action_text, 'We ask for the key.');

  const longTranscript = 'spoken action '.repeat(50);
  const longer = submitInteraction(adventure, withSession(initial.session, { variables: { trust: 1 } }), {
    kind: 'choice', choice_id: 'left-path', action_text: 'Ask for the key.',
  }, { requestId: '66666666-6666-4666-8666-666666666666', originalText: longTranscript });
  assert.equal(longer.session.event_log.at(-1)?.action_text, longTranscript.trim());
  assertEngineError(() => submitInteraction(adventure, withSession(initial.session, { variables: { trust: 1 } }), {
    kind: 'choice', choice_id: 'left-path', action_text: 'Ask for the key.',
  }, { requestId: '77777777-7777-4777-8777-777777777777', originalText: 'x'.repeat(1201) }), 'ACTION_TEXT_TOO_LONG');
});

test('unavailable or forged choices and out-of-bounds effects do not mutate the session', () => {
  const adventure = makeAdventure();
  const { session } = start(adventure);

  assertEngineError(() => submitInteraction(adventure, session, {
    kind: 'choice', choice_id: 'left-path', action_text: 'Take the left path',
  }, { requestId: nextRequestId }), 'CHOICE_UNAVAILABLE');
  assertEngineError(() => submitInteraction(adventure, session, {
    kind: 'choice', choice_id: 'made-up', action_text: 'Invent a path',
  }, { requestId: nextRequestId }), 'CHOICE_NOT_FOUND');

  const maxed = withSession(session, { variables: { trust: 2 } });
  const overflowing = makeAdventure();
  overflowing.nodes[0].choices[0].conditions = [];
  overflowing.nodes[0].choices[0].effects = [{ kind: 'increment_variable', variable_id: 'trust', amount: 1 }];
  assertEngineError(() => submitInteraction(overflowing, maxed, {
    kind: 'choice', choice_id: 'left-path', action_text: 'Overfill trust',
  }, { requestId: nextRequestId }), 'EFFECT_OUT_OF_BOUNDS');
  assert.equal(session.revision, 1);
  assert.equal(session.current_node_id, 'opening');
});

test('free actions require current affordances, valid targets, approach and owned allowed items', () => {
  const adventure = makeAdventure();
  const { session } = start(adventure);
  const base = { kind: 'free_action' as const, affordance_id: 'talk-to-keeper', action_text: 'Use the key.' };

  assertEngineError(() => submitInteraction(adventure, session, {
    ...base, target_id: 'keeper', approach_id: 'polite',
  }, { requestId: nextRequestId }), 'CHOICE_UNAVAILABLE');
  const eligible = withSession(session, { variables: { trust: 1 } });
  assertEngineError(() => submitInteraction(adventure, eligible, {
    ...base, approach_id: 'polite', item_id: 'brass-key',
  }, { requestId: nextRequestId }), 'CLARIFICATION_REQUIRED');
  assertEngineError(() => submitInteraction(adventure, eligible, {
    ...base, target_id: 'invented-target', approach_id: 'polite',
  }, { requestId: nextRequestId }), 'ACTION_NOT_ALLOWED');
  assertEngineError(() => submitInteraction(adventure, eligible, {
    ...base, target_id: 'keeper', approach_id: 'invented-approach',
  }, { requestId: nextRequestId }), 'ACTION_NOT_ALLOWED');
  assertEngineError(() => submitInteraction(adventure, eligible, {
    ...base, target_id: 'keeper', approach_id: 'polite', item_id: 'brass-key',
  }, { requestId: nextRequestId }), 'ITEM_NOT_OWNED');
  assertEngineError(() => submitInteraction(adventure, eligible, {
    ...base, target_id: 'keeper', approach_id: 'polite', item_id: 'invented-item',
  }, { requestId: nextRequestId }), 'ITEM_NOT_ALLOWED');

  const carryingKey = withSession(eligible, { inventory: ['brass-key'] });
  const result = submitInteraction(adventure, carryingKey, {
    ...base, target_id: 'keeper', approach_id: 'polite', item_id: 'brass-key',
  }, { requestId: nextRequestId }, { now: () => fixedNow });
  assert.equal(result.session.phase, 'ended');
  assert.equal(result.session.current_node_id, 'left-ending');
  assert.equal(result.session.event_log.at(-1)?.affordance_id, 'talk-to-keeper');
  assert.equal(result.session.event_log.at(-1)?.target_id, 'keeper');
  assert.equal(result.session.event_log.at(-1)?.approach_id, 'polite');
  assert.equal(result.session.event_log.at(-1)?.item_id, 'brass-key');
});

test('checks are server-pending, bind their ID, use an injected d20, and settle success/setback as one revision', () => {
  const adventure = makeAdventure();
  const initial = start(adventure);
  const opened = submitInteraction(adventure, initial.session, {
    kind: 'choice', choice_id: 'right-path', action_text: 'Try the risky path.',
  }, { requestId: nextRequestId }, { now: () => fixedNow, createId: () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
  assert.equal(opened.session.phase, 'awaiting_check');
  assert.equal(opened.turn.pending_check?.id, 'check-bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb');
  assert.equal(opened.turn.choices.length, 0);
  assert.equal(opened.session.revision, 2);

  let rolls = 0;
  assertEngineError(() => resolvePendingCheck(adventure, opened.session, {
    checkId: 'check-cccccccc-cccc-4ccc-8ccc-cccccccccccc', requestId: '44444444-4444-4444-8444-444444444444',
  }, { rollD20: () => { rolls += 1; return 20; } }), 'CHECK_ID_MISMATCH');
  assert.equal(rolls, 0, 'a stale check ID must not consume a roll');

  const success = resolvePendingCheck(adventure, opened.session, {
    checkId: opened.turn.pending_check!.id, requestId: '44444444-4444-4444-8444-444444444444',
  }, { now: () => fixedNow, rollD20: () => 12 });
  assert.equal(success.session.current_node_id, 'left-ending');
  assert.equal(success.session.phase, 'ended');
  assert.equal(success.session.variables.trust, 1);
  assert.equal(success.turn.recent_outcome?.kind, 'check');
  if (success.turn.recent_outcome?.kind === 'check') {
    assert.equal(success.turn.recent_outcome.result, 'success');
    assert.equal(success.turn.recent_outcome.total, 12);
  }
  assert.equal(success.session.revision, 3);
  assert.equal(success.session.event_log.at(-1)?.check_total, 12);

  const setback = resolvePendingCheck(adventure, opened.session, {
    checkId: opened.turn.pending_check!.id, requestId: '55555555-5555-4555-8555-555555555555',
  }, { now: () => fixedNow, rollD20: () => 1 });
  assert.equal(setback.session.current_node_id, 'right-ending');
  assert.equal(setback.session.phase, 'ended');
  assert.equal(setback.session.variables.trust, 0);
  assert.equal(setback.turn.recent_outcome?.kind === 'check' && setback.turn.recent_outcome.result, 'setback');
});

test('rejects an adventure version different from the session binding', () => {
  const adventure = makeAdventure();
  const { session } = start(adventure);
  const changedVersion = { ...adventure, version: 2 };
  assertEngineError(() => getPublicTurn(changedVersion, session), 'ADVENTURE_VERSION_MISMATCH');
  const differentLocale = { ...adventure, locale: 'es' };
  assertEngineError(() => getPublicTurn(differentLocale, session), 'ADVENTURE_VERSION_MISMATCH');
});

test('explicit closure preserves the current scene, clears a pending check, and does not forge an ending', () => {
  const adventure = makeAdventure();
  const initial = start(adventure);
  const closed = endSession(adventure, initial.session, { requestId: nextRequestId }, { now: () => fixedNow });
  assert.equal(closed.session.phase, 'ended');
  assert.equal(closed.session.current_node_id, 'opening');
  assert.equal(closed.turn.scene_id, 'opening');
  assert.equal(closed.turn.choices.length, 0);
  assert.equal(closed.session.event_log.at(-1)?.kind, 'ended');
  assert.equal(closed.session.event_log.at(-1)?.choice_id, null);
  assert.match(closed.session.recap, /closed the session/);
  assertEngineError(() => endSession(adventure, closed.session, { requestId: '88888888-8888-4888-8888-888888888888' }), 'ALREADY_ENDED');

  const pending = submitInteraction(adventure, initial.session, {
    kind: 'choice', choice_id: 'right-path', action_text: 'Try the risky path.',
  }, { requestId: nextRequestId });
  const closedPending = endSession(adventure, pending.session, { requestId: '88888888-8888-4888-8888-888888888888' });
  assert.equal(closedPending.session.phase, 'ended');
  assert.equal(closedPending.session.pending_check, null);
  assert.equal(closedPending.session.event_log.filter(({ kind }) => kind === 'ended').length, 1);

  assertEngineError(() => getPublicTurn(adventure, withSession(closed.session, {
    current_node_id: 'left-ending',
  })), 'INVALID_STATE');
});

test('long authored check prompts remain valid and corrupt cross-adventure state is rejected', () => {
  const adventure = makeAdventure();
  adventure.nodes[0].choices[1].action = 'a'.repeat(220);
  const initial = start(adventure);
  const pending = submitInteraction(adventure, initial.session, {
    kind: 'choice', choice_id: 'right-path', action_text: 'Try the risky path.',
  }, { requestId: nextRequestId });
  assert.equal(pending.turn.pending_check?.prompt.length, 220);

  const corrupt = withSession(initial.session, { variables: { trust: 3 } });
  assertEngineError(() => getPublicTurn(adventure, corrupt), 'INVALID_STATE');
  assertEngineError(() => getPublicTurn(adventure, withSession(initial.session, {
    current_node_id: 'left-ending',
  })), 'INVALID_STATE');
});
