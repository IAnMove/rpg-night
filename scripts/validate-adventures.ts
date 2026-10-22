import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HostResponseSchema, ListAdventuresResponseSchema, SubmitActionRequestSchema } from '../shared/host-schema.js';
import { PublicErrorSchema, PublicOperationSchema, PublicTurnSchema, StoredOperationSchema } from '../shared/session-schema.js';
import { formatAdventureIssues, validateAdventureDefinition } from '../shared/adventure-validation.js';

const fixtureRoot = path.resolve('shared/fixtures');

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, 'utf8')) as unknown;
}

export async function runFixtureValidation(): Promise<void> {
  const validPath = path.join(fixtureRoot, 'adventures', 'valid-minimal.json');
  const invalidPath = path.join(fixtureRoot, 'adventures', 'invalid-cycle.json');
  const invalidReferencePath = path.join(fixtureRoot, 'adventures', 'invalid-reference.json');
  const valid = validateAdventureDefinition(await readJson(validPath));
  if (!valid.ok) throw new Error(`Expected valid fixture to pass:\n${formatAdventureIssues(valid.issues)}`);
  const listResponse = ListAdventuresResponseSchema.safeParse({ adventures: [{
    id: valid.adventure.id,
    version: valid.adventure.version,
    title: valid.adventure.title,
    locale: valid.adventure.locale,
    genre: valid.adventure.genre,
    tone: valid.adventure.tone,
    duration_minutes: valid.adventure.duration_minutes,
    players: valid.adventure.players,
    objective: valid.adventure.objective,
  }] });
  if (!listResponse.success) throw new Error(`Invalid adventure list summary: ${listResponse.error.message}`);
  const invalid = validateAdventureDefinition(await readJson(invalidPath));
  if (invalid.ok || !invalid.issues.some((issue) => /acyclic/.test(issue.message))) {
    throw new Error('Expected invalid-cycle.json to fail with a cycle diagnostic');
  }
  const invalidReference = validateAdventureDefinition(await readJson(invalidReferencePath));
  if (invalidReference.ok || !invalidReference.issues.some((issue) => /unknown node/.test(issue.message))) {
    throw new Error('Expected invalid-reference.json to fail with an unknown-node diagnostic');
  }

  const publicRoot = path.join(fixtureRoot, 'public');
  for (const phase of ['awaiting-choice', 'awaiting-check', 'busy', 'paused', 'ended']) {
    const parsed = PublicTurnSchema.safeParse(await readJson(path.join(publicRoot, `turn-${phase}.json`)));
    if (!parsed.success) throw new Error(`Invalid PublicTurn fixture ${phase}: ${parsed.error.message}`);
  }
  for (const status of ['pending', 'ready', 'failed']) {
    const parsed = PublicOperationSchema.safeParse(await readJson(path.join(publicRoot, `operation-${status}.json`)));
    if (!parsed.success) throw new Error(`Invalid operation fixture ${status}: ${parsed.error.message}`);
  }
  const pendingOperation = StoredOperationSchema.safeParse({
    operation_id: '22222222-2222-4222-8222-222222222222',
    kind: 'prepare_adventure', owner_kind: 'request', owner_id: '44444444-4444-4444-8444-444444444444',
    request_id: '22222222-2222-4222-8222-222222222222', input_fingerprint: 'sha256:fixture',
    status: 'pending', created_at: '2026-10-22T08:00:00.000Z', expires_at: '2026-10-22T08:05:00.000Z',
  });
  if (!pendingOperation.success) throw new Error(`Invalid pending operation record: ${pendingOperation.error.message}`);
  const readyResult = await readJson(path.join(publicRoot, 'operation-ready.json'));
  const invalidPendingWithResult = StoredOperationSchema.safeParse({
    operation_id: '22222222-2222-4222-8222-222222222222',
    kind: 'prepare_adventure', owner_kind: 'request', owner_id: '44444444-4444-4444-8444-444444444444',
    request_id: '22222222-2222-4222-8222-222222222222', input_fingerprint: 'sha256:fixture',
    status: 'pending', created_at: '2026-10-22T08:00:00.000Z', expires_at: '2026-10-22T08:05:00.000Z',
    public_result: readyResult,
  });
  if (invalidPendingWithResult.success) throw new Error('Pending operation must reject a terminal public result');
  const invalidStoredKind = StoredOperationSchema.safeParse({
    operation_id: '22222222-2222-4222-8222-222222222222',
    kind: 'generate_art', owner_kind: 'request', owner_id: '44444444-4444-4444-8444-444444444444',
    request_id: '22222222-2222-4222-8222-222222222222', input_fingerprint: 'sha256:fixture',
    status: 'ready', created_at: '2026-10-22T08:00:00.000Z', expires_at: '2026-10-22T08:05:00.000Z',
    public_result: readyResult,
  });
  if (invalidStoredKind.success) throw new Error('Stored operation must reject a public result with a different kind');
  const invalidStoredStatus = StoredOperationSchema.safeParse({
    operation_id: '22222222-2222-4222-8222-222222222222',
    kind: 'prepare_adventure', owner_kind: 'request', owner_id: '44444444-4444-4444-8444-444444444444',
    request_id: '22222222-2222-4222-8222-222222222222', input_fingerprint: 'sha256:fixture',
    status: 'failed', created_at: '2026-10-22T08:00:00.000Z', expires_at: '2026-10-22T08:05:00.000Z',
    public_result: readyResult,
  });
  if (invalidStoredStatus.success) throw new Error('Stored operation must reject a public result with a different status');

  const choiceRequest = SubmitActionRequestSchema.safeParse({
    session_id: '11111111-1111-4111-8111-111111111111', expected_revision: 1,
    request_id: '22222222-2222-4222-8222-222222222222',
    interaction: { kind: 'choice', choice_id: 'left-path', action_text: 'Take that path' },
  });
  if (!choiceRequest.success) throw new Error(`Invalid typed action request: ${choiceRequest.error.message}`);
  for (const name of ['clarification', 'error-revision-conflict']) {
    const value = await readJson(path.join(publicRoot, `${name}.json`));
    const parsed = name === 'clarification'
      ? HostResponseSchema.safeParse(value)
      : PublicErrorSchema.safeParse(value);
    if (!parsed.success) throw new Error(`Invalid public result fixture ${name}: ${parsed.error.message}`);
  }
}

async function validatePaths(paths: string[]): Promise<boolean> {
  let valid = true;
  for (const file of paths) {
    const data = await readJson(path.resolve(file));
    const result = validateAdventureDefinition(data);
    if (!result.ok) {
      valid = false;
      console.error(`${file}: invalid\n${formatAdventureIssues(result.issues)}`);
    } else {
      console.log(`${file}: valid (${result.adventure.id}, ${result.adventure.nodes.length} nodes)`);
    }
  }
  return valid;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--self-test') {
    await runFixtureValidation();
    console.log('Adventure and public DTO fixtures: valid/invalid cases passed.');
    return;
  }
  const paths = args.length ? args : [path.join(fixtureRoot, 'adventures', 'valid-minimal.json')];
  if (!(await validatePaths(paths))) process.exitCode = 1;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
