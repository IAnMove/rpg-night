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
});
