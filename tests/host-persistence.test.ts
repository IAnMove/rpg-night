import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ConversationHost } from '../mcp-server/host/service.js';
import { JsonConversationStore } from '../mcp-server/host/conversation-store.js';

test('conversation creation and controls survive a host reconstruction and replay idempotently', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpg-night-host-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const firstHost = new ConversationHost({ dataDir: dir, trace: () => undefined });
  const created = await firstHost.createConversation({ request_id: '11111111-1111-4111-8111-111111111111', locale: 'es' });
  assert.equal(created.kind, 'message');
  if (created.kind !== 'message') assert.fail('expected pre-game message');
  assert.match(created.assistant_text, /jugadores/);

  const restored = new ConversationHost({ dataDir: dir, trace: () => undefined });
  const replayedCreate = await restored.createConversation({ request_id: '11111111-1111-4111-8111-111111111111', locale: 'es' });
  assert.deepEqual(replayedCreate, created);
  const paused = await restored.pause('11111111-1111-4111-8111-111111111111', { request_id: '22222222-2222-4222-8222-222222222222' });
  assert.equal(paused.kind, 'message');
  const pauseReplay = await restored.pause('11111111-1111-4111-8111-111111111111', { request_id: '22222222-2222-4222-8222-222222222222' });
  assert.deepEqual(pauseReplay, paused);
  const conflictingReuse = await restored.resume('11111111-1111-4111-8111-111111111111', { request_id: '22222222-2222-4222-8222-222222222222' });
  assert.equal(conflictingReuse.kind, 'error');

  const disk = await new JsonConversationStore(path.join(dir, 'conversations-v1')).get('11111111-1111-4111-8111-111111111111');
  assert.equal(disk.paused, true);
  assert.equal(disk.session_id, null);
  assert.equal(disk.conversation.locale, 'es');
  await firstHost.close(); await restored.close();
});

test('a mismatched create retry cannot reuse an existing conversation key', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpg-night-host-key-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const host = new ConversationHost({ dataDir: dir, trace: () => undefined });
  t.after(() => host.close());
  await host.createConversation({ request_id: '33333333-3333-4333-8333-333333333333', locale: 'en' });
  const reused = await host.createConversation({ request_id: '33333333-3333-4333-8333-333333333333', locale: 'es' });
  assert.equal(reused.kind, 'error');
  if (reused.kind === 'error') assert.equal(reused.code, 'IDEMPOTENCY_KEY_REUSED');
});
