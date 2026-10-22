import assert from 'node:assert/strict';
import test from 'node:test';
import { HostResponseSchema, StartSessionRequestSchema } from '../shared/host-schema.js';

test('start_session defaults to English while accepting an explicit Spanish adventure locale', () => {
  const common = {
    request_id: '11111111-1111-4111-8111-111111111111',
    adventure_id: 'elderglen',
    players: ['Ada'],
  };
  assert.equal(StartSessionRequestSchema.parse(common).locale, 'en');
  assert.equal(StartSessionRequestSchema.parse({ ...common, locale: 'es' }).locale, 'es');
  assert.equal(StartSessionRequestSchema.safeParse({ ...common, locale: 'fr' }).success, false);
});

test('host can answer a pre-game question before a PublicTurn exists', () => {
  const parsed = HostResponseSchema.parse({
    kind: 'message',
    conversation: {
      conversation_id: '22222222-2222-4222-8222-222222222222',
      locale: 'es',
      session_id: null,
      created_at: '2026-10-22T12:00:00.000Z',
    },
    assistant_text: '¿Qué aventura os apetece jugar?',
  });
  assert.equal(parsed.kind, 'message');
});
