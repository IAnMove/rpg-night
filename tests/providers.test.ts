import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { BedrockProvider, DemoProvider } from '../mcp-server/providers.js';
import { Game } from '../mcp-server/game.js';
import { readConfig } from '../mcp-server/config.js';
import type { Session } from '../shared/types.js';

function fakeClient(provider: BedrockProvider, send: (command: { input: Record<string, unknown> }) => Promise<unknown>) {
  (provider as unknown as { client: { send: typeof send } }).client = { send };
}
async function fixture(t: test.TestContext) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'rpg-night-bedrock-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = readConfig({ PROVIDER: 'bedrock', DATA_DIR: directory });
  const demo = new Game(config, new DemoProvider()); await demo.init();
  const session = await demo.start({ world: 'space', language: 'es', players: ['Ana'] });
  return { config, session, provider: new BedrockProvider(config) };
}
const generated = { title: 'Un nuevo horizonte', narration: 'Una ciudad despierta entre los anillos. Sus viajeros os saludan.', imagePrompt: 'A luminous miniature city among Saturn rings, cinematic storybook illustration', choices: [{ text: 'Hablar con los viajeros', risky: false }, { text: 'Saltar al portal', risky: true }] };
test('Bedrock Converse parses JSON and receives party, locale and authoritative dice context', async t => {
  const { provider, session } = await fixture(t); let input: Record<string, unknown> | undefined;
  fakeClient(provider, async command => { input = command.input; return { output: { message: { content: [{ text: `\u0060\u0060\u0060json\n${JSON.stringify(generated)}\n\u0060\u0060\u0060` }] } } }; });
  const response = await provider.generate({ session, action: 'Saltar', success: false });
  assert.equal(response.warnings.length, 0); assert.equal(response.scene.title, generated.title);
  assert.equal(response.scene.outcome, 'setback'); assert.equal(response.scene.choices[1].risky, true);
  assert.match(JSON.stringify(input), /Spanish/); assert.match(JSON.stringify(input), /Setback/); assert.match(JSON.stringify(input), /Ana/);
});
test('Bedrock forced ending removes choices even if the model returns them', async t => {
  const { provider, session } = await fixture(t);
  fakeClient(provider, async () => ({ output: { message: { content: [{ text: JSON.stringify(generated) }] } } }));
  const response = await provider.generate({ session, forceEnd: true }); assert.equal(response.scene.isEnding, true); assert.deepEqual(response.scene.choices, []);
});
test('Bedrock image request uses Nova Canvas payload and persists decoded PNG', async t => {
  const { provider, session, config } = await fixture(t); let input: Record<string, unknown> | undefined;
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=';
  fakeClient(provider, async command => { input = command.input; return { body: new TextEncoder().encode(JSON.stringify({ images: [png] })) }; });
  const scene = await new DemoProvider().generate({ session });
  const sceneId = '12345678-1234-4234-8234-123456789012'; const url = await provider.image(scene.scene, session, sceneId);
  assert.equal(url, `/api/images/${sceneId}.png`); assert.equal(input?.modelId, 'amazon.nova-canvas-v1:0');
  const body = JSON.parse(input?.body as string); assert.equal(body.taskType, 'TEXT_IMAGE'); assert.equal(body.imageGenerationConfig.numberOfImages, 1);
  assert.deepEqual(await readFile(path.join(config.dataDir, 'images', `${sceneId}.png`)), Buffer.from(png, 'base64'));
});
test('image failures preserve a playable session with a visible local-art warning', async t => {
  const { config } = await fixture(t);
  const provider = new DemoProvider(); provider.image = async () => { throw new Error('Unavailable'); };
  const game = new Game(config, provider); await game.init();
  const session = await game.start({ world: 'fantasy', language: 'en', players: ['Sam'] });
  assert.equal(session.status, 'active'); assert.match(session.scenes[0].imageUrl, /^\/api\/art\//); assert.match(session.warnings[0], /local illustration/);
});
