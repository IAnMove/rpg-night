import assert from 'node:assert/strict';
import test from 'node:test';
import { HostPublicStateSchema } from '../shared/host-schema.js';
import { hostComicSvg } from '../mcp-server/comic.js';

test('host comic exports only public story snapshots and escapes player-facing text', () => {
  const turn = {
    schema_version: 2 as const, session_id: '11111111-1111-4111-8111-111111111111', locale: 'en' as const,
    revision: 2, view_revision: 2, phase: 'ended' as const, scene_id: 'final-room',
    narration: 'The sign reads <script>alert(1)</script>.', choices: [], affordances: [], pending_check: null,
    recent_outcome: { kind: 'ending' as const, ending_id: 'safe-ending', summary: 'The lantern glows & everyone smiles.' },
    inventory: [], recap: 'The group reached the final room.', next_expected_input: '', visual_status: 'ready' as const,
  };
  const state = HostPublicStateSchema.parse({
    conversation_id: '22222222-2222-4222-8222-222222222222', locale: 'en', session_id: turn.session_id,
    paused: false, turn, turns: [turn],
  });
  const svg = hostComicSvg(state);
  assert.match(svg, /Your story, together/);
  assert.match(svg, /The lantern glows &amp; everyone smiles/);
  assert.match(svg, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /THE END/);
  assert.match(svg, /data:image\/svg\+xml;base64,/);
});

test('host comic preserves long captions and decisions without clipping or duplicating an early stop', () => {
  const turn = {
    schema_version: 2 as const, session_id: '11111111-1111-4111-8111-111111111111', locale: 'es' as const,
    revision: 1, view_revision: 1, phase: 'awaiting_choice' as const, scene_id: 'archive',
    narration: 'Una pista entre los libros. '.repeat(47) + 'ÚLTIMA PISTA VISIBLE.',
    choices: [{ id: 'read', label: 'Leer el libro' }], affordances: [], pending_check: null,
    recent_outcome: null, inventory: [], recap: '', next_expected_input: 'Elegid.', visual_status: 'ready' as const,
  };
  const ended = { ...turn, revision: 2, view_revision: 2, phase: 'ended' as const, choices: [], next_expected_input: '',
    recent_outcome: { kind: 'action' as const, action_label: 'Una decisión del grupo. '.repeat(8) + 'DECISIÓN FINAL.', summary: 'Una consecuencia pública. '.repeat(45) + 'CONSECUENCIA FINAL.' } };
  const state = HostPublicStateSchema.parse({ conversation_id: '22222222-2222-4222-8222-222222222222', locale: 'es', session_id: turn.session_id, paused: false, turn: ended, turns: [turn, ended] });
  const svg = hostComicSvg(state);
  assert.match(svg, /ÚLTIMA PISTA VISIBLE/);
  assert.match(svg, /DECISIÓN FINAL/);
  assert.match(svg, /CONSECUENCIA FINAL/);
  assert.equal((svg.match(/<image /g) ?? []).length, 1, 'an explicit stop updates the same scene panel');
  assert.ok(Number(svg.match(/height="(\d+)"/)?.[1]) > 1400, 'long content expands the document instead of being cut off');
});
