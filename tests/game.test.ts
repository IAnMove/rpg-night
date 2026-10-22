import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Game, GameError } from '../mcp-server/game.js';
import { readConfig } from '../mcp-server/config.js';
import { comicSvg } from '../mcp-server/comic.js';
import { DemoProvider, BedrockProvider } from '../mcp-server/providers.js';
import { sceneArt } from '../mcp-server/art.js';
import type { Session, World } from '../shared/types.js';

async function fixture(t: test.TestContext, roll = 15) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpg-night-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const config = readConfig({ DATA_DIR: dir });
  const game = new Game(config, new DemoProvider(), () => roll); await game.init(); return { game, config };
}
const party = { world: 'fantasy' as const, language: 'en' as const, players: ['Mira', 'Leo'] };

test('all worlds are playable in English and Spanish with distinct art and endings', async t => {
  const { game } = await fixture(t);
  for (const world of ['fantasy', 'space', 'mystery'] as World[]) for (const language of ['en', 'es'] as const) {
    let session = await game.start({ ...party, world, language });
    assert.equal(session.scenes.length, 1); assert.equal(session.scenes[0].choices.length, 3);
    while (session.status === 'active') {
      const choice = session.scenes.at(-1)!.choices[2];
      session = await game.action(session.id, { action: choice.text, choiceId: choice.id });
    }
    assert.equal(session.scenes.length, 6); assert.equal(session.scenes.at(-1)!.isEnding, true);
    assert.deepEqual(session.scenes.at(-1)!.choices, []); assert.ok(session.inventory.length > 0);
    assert.equal(new Set(session.scenes.map(s => s.imageUrl)).size, 6);
    assert.match(session.scenes[1].narration, language === 'es' ? /aliado/ : /ally/);
  }
});
test('risky choices consume a fresh d20 and make setbacks part of the story', async t => {
  const { game } = await fixture(t, 3); const start = await game.start(party);
  const rolled = await game.dice(start.id, {}); assert.equal(rolled.lastRoll?.total, 3);
  const choice = start.scenes[0].choices[1]; const result = await game.action(start.id, { action: choice.text, choiceId: choice.id });
  assert.equal(result.lastRoll?.id, rolled.lastRoll?.id); assert.equal(result.lastRoll?.used, true);
  assert.equal(result.scenes[1].outcome, 'setback'); assert.equal(result.inventory.length, 0);
  const next = result.scenes[1].choices[1]; const again = await game.action(start.id, { action: next.text, choiceId: next.id });
  assert.notEqual(again.lastRoll?.id, rolled.lastRoll?.id); assert.equal(again.scenes.length, 3);
});
test('custom dice cannot be used to guarantee story success', async t => {
  const { game } = await fixture(t, 4); const session = await game.start(party);
  await game.dice(session.id, { sides: 100, modifier: 100 });
  const result = await game.action(session.id, { action: 'Leap', choiceId: session.scenes[0].choices[1].id });
  assert.equal(result.lastRoll?.sides, 20); assert.equal(result.lastRoll?.modifier, 0); assert.equal(result.scenes[1].outcome, 'setback');
});
test('success grants inventory and safe choices preserve an unused roll', async t => {
  const { game } = await fixture(t, 18); const session = await game.start(party);
  await game.dice(session.id, {});
  const safe = session.scenes[0].choices[0]; const first = await game.action(session.id, { action: safe.text, choiceId: safe.id });
  assert.equal(first.lastRoll?.used, false);
  const risk = first.scenes[1].choices[1]; const second = await game.action(session.id, { action: risk.text, choiceId: risk.id });
  assert.equal(second.scenes[2].outcome, 'success'); assert.ok(second.inventory.length > 0);
});
test('concurrent copies of a choice advance only once', async t => {
  const { game } = await fixture(t); const session = await game.start(party); const choice = session.scenes[0].choices[0];
  const results = await Promise.allSettled([1, 2].map(() => game.action(session.id, { action: choice.text, choiceId: choice.id })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(game.get(session.id).scenes.length, 2);
});
test('each persisted mutation has a monotonic revision for multi-screen ordering', async t => {
  const { game } = await fixture(t); const start = await game.start(party); const rolled = await game.dice(start.id, {});
  const choice = rolled.scenes[0].choices[0]; const moved = await game.action(start.id, { action: choice.text, choiceId: choice.id });
  assert.equal(start.revision, 1); assert.equal(rolled.revision, 2); assert.equal(moved.revision, 3);
});
test('session persistence, immutable reads and idempotent ending', async t => {
  const { game, config } = await fixture(t); const session = await game.start(party);
  game.get(session.id).players.push('Not saved');
  const ended = await game.end(session.id); assert.equal(ended.status, 'ended');
  assert.deepEqual(await game.end(session.id), ended);
  const restored = new Game(config); await restored.init(); assert.deepEqual(restored.get(session.id), ended);
  assert.equal(restored.get(session.id).players.length, 2);
  await assert.rejects(game.dice(session.id, {}), (error: unknown) => error instanceof GameError && error.status === 409);
});
test('validation prevents invalid sessions, excessive input and dice values', async t => {
  const { game } = await fixture(t);
  assert.throws(() => game.get('../../.env')); assert.throws(() => game.get('00000000-0000-4000-8000-000000000000'));
  await assert.rejects(game.start({ ...party, players: [] }));
  const session = await game.start(party);
  await assert.rejects(game.action(session.id, { action: 'x'.repeat(601) }));
  await assert.rejects(game.dice(session.id, { sides: 1 }));
  await assert.rejects(game.dice(session.id, { count: 11 }));
});
test('a malformed saved session is skipped without losing valid games', async t => {
  const { game, config } = await fixture(t); const good = await game.start(party); const broken = await game.start(party);
  await writeFile(path.join(config.dataDir, `${broken.id}.json`), JSON.stringify({ ...broken, scenes: [{ ...broken.scenes[0], imageUrl: 'https://untrusted.example/image.svg' }] }));
  const restored = new Game(config); await restored.init(); assert.equal(restored.get(good.id).title, good.title); assert.throws(() => restored.get(broken.id));
});
test('comic embeds images and escapes untrusted names and actions', async t => {
  const { game, config } = await fixture(t);
  const session = await game.start({ ...party, players: ['<script>bad</script>'] });
  const result = await game.action(session.id, { action: '<img src=x onerror=bad>' });
  const svg = await comicSvg(result, config.dataDir);
  assert.match(svg, /data:image\/svg\+xml;base64/); assert.doesNotMatch(svg, /<script>|<img src/);
  assert.match(svg, /&lt;script&gt;/); assert.match(svg, /&lt;img/);
});
test('demo artwork varies by world, chapter and chosen path', () => {
  assert.notEqual(sceneArt('fantasy', 1), sceneArt('fantasy', 2));
  assert.notEqual(sceneArt('fantasy', 1, 0), sceneArt('fantasy', 1, 2));
  assert.notEqual(sceneArt('space'), sceneArt('mystery'));
});
test('malformed Bedrock text falls back explicitly rather than breaking the game', async t => {
  const { game, config } = await fixture(t); const session = await game.start(party);
  const provider = new BedrockProvider({ ...config, provider: 'bedrock' });
  // Inject an in-process fake transport: no AWS credentials or calls are used.
  (provider as unknown as { client: { send: () => Promise<unknown> } }).client = { send: async () => ({ output: { message: { content: [{ text: 'not valid JSON' }] } } }) };
  const result = await provider.generate({ session }); assert.equal(result.warnings.length, 1); assert.equal(result.scene.number, 2);
});
