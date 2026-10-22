import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import test from 'node:test';
import minimalAdventure from '../shared/fixtures/adventures/valid-minimal.json' with { type: 'json' };
import {
  createInitialSession,
  resolvePendingCheck,
  submitInteraction,
} from '../mcp-server/engine/core.js';
import { JsonSessionStore, SessionStoreError } from '../mcp-server/engine/store.js';
import type { AdventureDefinition } from '../shared/adventure-schema.js';
import type { PersistedSessionV2 } from '../shared/session-schema.js';

const fixedNow = '2026-10-22T12:00:00.000Z';
const sessionId = '11111111-1111-4111-8111-111111111111';
const startRequestId = '22222222-2222-4222-8222-222222222222';
const actionRequestId = '33333333-3333-4333-8333-333333333333';
const checkRequestId = '44444444-4444-4444-8444-444444444444';

async function withStore(run: (directory: string, store: JsonSessionStore) => Promise<void>): Promise<void> {
  const directory = path.resolve('.work', `test-store-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  try {
    await run(directory, new JsonSessionStore(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function adventureWithCheck(): AdventureDefinition {
  const adventure = structuredClone(minimalAdventure) as unknown as AdventureDefinition;
  const opening = adventure.nodes.find((node) => node.id === 'opening');
  assert.ok(opening?.kind === 'scene');
  opening.choices[0]!.transition = {
    kind: 'check', sides: 20, difficulty_class: 11,
    success_node_id: 'left-ending', setback_node_id: 'right-ending',
    success_effects: [], setback_effects: [],
  };
  return adventure;
}

function startSession(adventure: AdventureDefinition): PersistedSessionV2 {
  return createInitialSession(adventure, {
    sessionId,
    requestId: startRequestId,
    players: ['Mira'],
  }, {
    now: () => fixedNow,
    createId: () => 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  }).session;
}

test('mutateSession commits before return, replays by key before revision, and rejects changed reuse', async () => {
  const adventure = structuredClone(minimalAdventure) as unknown as AdventureDefinition;
  const initial = startSession(adventure);

  await withStore(async (directory, store) => {
    await store.createSession(initial);
    let executions = 0;
    const execute = (current: PersistedSessionV2) => {
      executions += 1;
      const applied = submitInteraction(adventure, current, {
        kind: 'choice', choice_id: 'left-path', action_text: 'Take the left path.',
      }, { requestId: actionRequestId }, { now: () => fixedNow });
      return { session: applied.session, response: { kind: 'turn' as const, turn: applied.turn } };
    };

    const first = await store.mutateSession(sessionId, {
      request_id: actionRequestId, command: 'submit_action', input_fingerprint: 'sha256:left', expected_revision: 1,
    }, execute);
    assert.equal(first.disposition, 'executed');
    assert.equal(first.session.revision, 2);
    assert.equal(first.session.idempotency_records.length, 1);
    const fromDisk = await store.getSession(sessionId);
    assert.equal(fromDisk.revision, 2, 'state and replay record must be durable before returning');

    const retry = await store.mutateSession(sessionId, {
      request_id: actionRequestId, command: 'submit_action', input_fingerprint: 'sha256:left', expected_revision: 1,
    }, execute);
    assert.equal(retry.disposition, 'replayed');
    assert.deepEqual(retry.response, first.response);
    assert.equal(executions, 1, 'same key is resolved before checking its now-stale revision');

    const reused = await store.mutateSession(sessionId, {
      request_id: actionRequestId, command: 'submit_action', input_fingerprint: 'sha256:other', expected_revision: 1,
    }, execute);
    assert.equal(reused.disposition, 'rejected');
    assert.equal(reused.response.kind, 'error');
    if (reused.response.kind === 'error') assert.equal(reused.response.code, 'IDEMPOTENCY_KEY_REUSED');
    assert.equal(executions, 1);
    assert.equal((await store.getSession(sessionId)).revision, 2);
  });
});

test('stale new request conflicts without executing or persisting a replay record', async () => {
  const adventure = structuredClone(minimalAdventure) as unknown as AdventureDefinition;
  const initial = startSession(adventure);
  await withStore(async (_directory, store) => {
    await store.createSession(initial);
    await store.mutateSession(sessionId, {
      request_id: actionRequestId, command: 'submit_action', input_fingerprint: 'sha256:first', expected_revision: 1,
    }, (current) => {
      const applied = submitInteraction(adventure, current, {
        kind: 'choice', choice_id: 'left-path', action_text: 'Take the left path.',
      }, { requestId: actionRequestId }, { now: () => fixedNow });
      return { session: applied.session, response: { kind: 'turn' as const, turn: applied.turn } };
    });
    let executions = 0;
    const conflict = await store.mutateSession(sessionId, {
      request_id: '55555555-5555-4555-8555-555555555555', command: 'submit_action', input_fingerprint: 'sha256:stale', expected_revision: 1,
    }, () => { executions += 1; throw new Error('must not run'); });
    assert.equal(conflict.disposition, 'rejected');
    assert.equal(conflict.response.kind, 'error');
    if (conflict.response.kind === 'error') {
      assert.equal(conflict.response.code, 'REVISION_CONFLICT');
      assert.equal(conflict.response.current_revision, 2);
    }
    assert.equal(executions, 0);
    assert.equal((await store.getSession(sessionId)).idempotency_records.length, 1);
  });
});

test('invalid request IDs are rejected before execution', async () => {
  const adventure = structuredClone(minimalAdventure) as unknown as AdventureDefinition;
  const initial = startSession(adventure);
  await withStore(async (_directory, store) => {
    await store.createSession(initial);
    let executions = 0;
    await assert.rejects(store.mutateSession(sessionId, {
      request_id: 'not-a-uuid', command: 'submit_action', input_fingerprint: 'sha256:bad-id', expected_revision: 1,
    }, () => { executions += 1; throw new Error('must not execute'); }), (error: unknown) =>
      error instanceof SessionStoreError && error.code === 'INVALID_SESSION');
    assert.equal(executions, 0);
    assert.equal((await store.getSession(sessionId)).revision, 1);
  });
});

test('concurrent requests at one revision serialize and only one action executes', async () => {
  const adventure = structuredClone(minimalAdventure) as unknown as AdventureDefinition;
  const initial = startSession(adventure);
  await withStore(async (_directory, store) => {
    await store.createSession(initial);
    let executions = 0;
    const makeMutation = (requestId: string, choiceId: string) => store.mutateSession(sessionId, {
      request_id: requestId, command: 'submit_action', input_fingerprint: `sha256:${choiceId}`, expected_revision: 1,
    }, (current) => {
      executions += 1;
      const applied = submitInteraction(adventure, current, {
        kind: 'choice', choice_id: choiceId, action_text: choiceId,
      }, { requestId }, { now: () => fixedNow });
      return { session: applied.session, response: { kind: 'turn' as const, turn: applied.turn } };
    });
    const results = await Promise.all([
      makeMutation(actionRequestId, 'left-path'),
      makeMutation('55555555-5555-4555-8555-555555555555', 'right-path'),
    ]);
    assert.equal(executions, 1);
    assert.equal(results.filter((result) => result.disposition === 'executed').length, 1);
    assert.equal(results.filter((result) => result.response.kind === 'error' && result.response.code === 'REVISION_CONFLICT').length, 1);
    const committed = await store.getSession(sessionId);
    assert.equal(committed.revision, 2);
    assert.equal(committed.idempotency_records.length, 1);
  });
});

test('a check retry after store restart returns its original roll without resolving again', async () => {
  const adventure = adventureWithCheck();
  const initial = startSession(adventure);
  await withStore(async (directory, originalStore) => {
    await originalStore.createSession(initial);
    const opened = await originalStore.mutateSession(sessionId, {
      request_id: actionRequestId, command: 'submit_action', input_fingerprint: 'sha256:start-check', expected_revision: 1,
    }, (current) => {
      const applied = submitInteraction(adventure, current, {
        kind: 'choice', choice_id: 'left-path', action_text: 'Try the check.',
      }, { requestId: actionRequestId }, { now: () => fixedNow, createId: () => 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' });
      return { session: applied.session, response: { kind: 'turn' as const, turn: applied.turn } };
    });
    assert.equal(opened.session.phase, 'awaiting_check');

    let rolls = 0;
    const resolve = (current: PersistedSessionV2) => {
      const applied = resolvePendingCheck(adventure, current, {
        checkId: current.pending_check!.id, requestId: checkRequestId,
      }, { now: () => fixedNow, rollD20: () => { rolls += 1; return 17; } });
      return { session: applied.session, response: { kind: 'turn' as const, turn: applied.turn } };
    };
    const first = await originalStore.mutateSession(sessionId, {
      request_id: checkRequestId, command: 'resolve_check', input_fingerprint: 'sha256:resolve-check', expected_revision: opened.session.revision,
    }, resolve);
    assert.equal(first.disposition, 'executed');
    assert.equal(rolls, 1);

    const restartedStore = new JsonSessionStore(directory);
    const retry = await restartedStore.mutateSession(sessionId, {
      request_id: checkRequestId, command: 'resolve_check', input_fingerprint: 'sha256:resolve-check', expected_revision: opened.session.revision,
    }, resolve);
    assert.equal(retry.disposition, 'replayed');
    assert.deepEqual(retry.response, first.response);
    assert.equal(rolls, 1);
    assert.equal((await restartedStore.getSession(sessionId)).revision, first.session.revision);
  });
});

test('corrupt JSON and incompatible versions are reported without overwrite', async () => {
  const directory = path.resolve('.work', `test-store-corrupt-${randomUUID()}`);
  await mkdir(directory, { recursive: true });
  try {
    const store = new JsonSessionStore(directory);
    const filename = path.join(directory, `${sessionId}.json`);
    await writeFile(filename, '{broken json', 'utf8');
    await assert.rejects(store.getSession(sessionId), (error: unknown) => error instanceof SessionStoreError && error.code === 'CORRUPT_SESSION');
    assert.equal(await readFile(filename, 'utf8'), '{broken json', 'corrupt source must be preserved');
    await assert.rejects(store.mutateSession(sessionId, {
      request_id: actionRequestId, command: 'submit_action', input_fingerprint: 'sha256:x', expected_revision: 1,
    }, () => { throw new Error('must not execute'); }), (error: unknown) => error instanceof SessionStoreError && error.code === 'CORRUPT_SESSION');
    assert.equal(await readFile(filename, 'utf8'), '{broken json');

    await writeFile(filename, JSON.stringify({ schema_version: 1, id: sessionId }), 'utf8');
    await assert.rejects(store.getSession(sessionId), (error: unknown) => error instanceof SessionStoreError && error.code === 'UNSUPPORTED_SESSION_VERSION');
    assert.deepEqual(JSON.parse(await readFile(filename, 'utf8')), { schema_version: 1, id: sessionId });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
