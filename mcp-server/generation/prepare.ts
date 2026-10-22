import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import { GetOperationStatusRequestSchema, PrepareAdventureRequestSchema, type PrepareAdventureRequest } from '../../shared/host-schema.js';
import { validateAdventureDefinition } from '../../shared/adventure-validation.js';
import { PublicErrorSchema, PublicOperationSchema, type PublicError, type PublicOperation, type StoredOperation } from '../../shared/session-schema.js';
import { JsonJobStore, JobStoreError } from '../jobs/store.js';
import type { AdventureGenerationProvider, AdventureRepairContext } from './provider.js';
import { validateGeneratedPlayability } from '../engine/playability.js';

export const ADVENTURE_OPERATION_TTL_MS = 5 * 60_000;
const MAX_ACTIVE_GENERATIONS = 2;
const MAX_QUEUED_GENERATIONS = 16;
const recoveries = new Map<string, Promise<void>>();

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  return JSON.stringify(value);
}
export function preparationFingerprint(request: PrepareAdventureRequest): string {
  const { request_id: _requestId, ...payload } = request;
  return `sha256:${createHash('sha256').update(canonical(payload)).digest('hex')}`;
}

function error(code: PublicError['code'], message: string, retryable = false): PublicError {
  return PublicErrorSchema.parse({ kind: 'error', code, message, retryable });
}
function issuePath(issue: string): string {
  const separator = issue.indexOf(':');
  return (separator < 0 ? 'request_preferences' : issue.slice(0, separator)).slice(0, 120);
}

/** A choice label is already public, player-facing language and is a safe fallback for omitted action text. */
function completeMissingChoiceActions(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const root = input as Record<string, unknown>;
  if (!Array.isArray(root.nodes)) return input;
  return {
    ...root,
    nodes: root.nodes.map((node) => {
      if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
      const current = node as Record<string, unknown>;
      if (current.kind !== 'scene' || !Array.isArray(current.choices)) return node;
      return {
        ...current,
        choices: current.choices.map((choice) => {
          if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return choice;
          const currentChoice = choice as Record<string, unknown>;
          return currentChoice.action === undefined && typeof currentChoice.label === 'string'
            ? { ...currentChoice, action: currentChoice.label }
            : choice;
        }),
      };
    }),
  };
}

type QueuedJob = { operationId: string; request: PrepareAdventureRequest };
export type AdventureGenerationEvent = {
  outcome: 'ready' | 'repair' | 'failed';
  phase?: 'validation' | 'provider_or_storage';
  issue_count?: number;
  issue_paths?: string[];
  error_code?: string;
  elapsed_ms?: number;
};

/** Validated, bounded, restart-aware preparation pipeline. Provider is injected by the app layer. */
export class AdventurePreparationService {
  readonly jobs: JsonJobStore;
  private readonly adventureDir: string;
  private readonly provider?: AdventureGenerationProvider;
  private readonly hasAdventure?: (id: string, locale: 'en' | 'es') => Promise<boolean>;
  private readonly now: () => Date;
  private readonly trace: (event: AdventureGenerationEvent) => void;
  private recovery: Promise<void> | undefined;
  private readonly queue: QueuedJob[] = [];
  private active = 0;

  constructor(options: { dataDir: string; adventureDir: string; provider?: AdventureGenerationProvider; hasAdventure?: (id: string, locale: 'en' | 'es') => Promise<boolean>; now?: () => Date; trace?: (event: AdventureGenerationEvent) => void }) {
    this.jobs = new JsonJobStore(path.join(options.dataDir, 'operations-v1'));
    this.adventureDir = path.resolve(options.adventureDir);
    this.provider = options.provider;
    this.hasAdventure = options.hasAdventure;
    this.now = options.now ?? (() => new Date());
    this.trace = options.trace ?? (() => undefined);
  }

  private async recover(): Promise<void> {
    if (!this.recovery) {
      const key = this.jobs.directory;
      this.recovery = recoveries.get(key) ?? this.jobs.failInterrupted(this.now()).then(() => undefined);
      recoveries.set(key, this.recovery);
    }
    return this.recovery;
  }

  async prepare(input: unknown): Promise<PublicOperation | PublicError> {
    const parsed = PrepareAdventureRequestSchema.parse(input);
    if (!this.provider) return error('OPERATION_FAILED', 'Adventure preparation provider is not configured.');
    try { await this.recover(); }
    catch { return error('INTERNAL_ERROR', 'The operation registry could not be recovered.'); }
    const now = this.now();
    const record: StoredOperation = {
      operation_id: parsed.request_id, kind: 'prepare_adventure', owner_kind: 'request', owner_id: parsed.request_id,
      request_id: parsed.request_id, input_fingerprint: preparationFingerprint(parsed), status: 'pending',
      created_at: now.toISOString(), expires_at: new Date(now.getTime() + ADVENTURE_OPERATION_TTL_MS).toISOString(),
    };
    let stored: { created: boolean; record: StoredOperation };
    try { stored = await this.jobs.createPending(record); }
    catch (cause) {
      if (cause instanceof JobStoreError && cause.code === 'IDEMPOTENCY_KEY_REUSED') return error('IDEMPOTENCY_KEY_REUSED', cause.message);
      if (cause instanceof JobStoreError && cause.code === 'CORRUPT') return error('INTERNAL_ERROR', 'The stored operation is invalid and was left untouched.');
      return error('INTERNAL_ERROR', 'The preparation operation could not be saved.', true);
    }
    if (stored.created) {
      if (this.queue.length >= MAX_QUEUED_GENERATIONS) {
        const failed = this.failed(stored.record, 'OPERATION_FAILED', 'The preparation queue is full. Try again later.', true);
        const completed = await this.jobs.complete(parsed.request_id, failed);
        return this.jobs.toPublic(completed);
      } else {
        this.queue.push({ operationId: parsed.request_id, request: parsed });
        this.pump();
      }
    }
    return this.jobs.toPublic(stored.record);
  }

  async getStatus(input: unknown): Promise<PublicOperation | PublicError> {
    const parsed = GetOperationStatusRequestSchema.parse(input);
    try { await this.recover(); return this.jobs.toPublic(await this.jobs.get(parsed.operation_id, this.now())); }
    catch (cause) {
      if (cause instanceof JobStoreError && cause.code === 'NOT_FOUND') return error('NOT_FOUND', 'The operation was not found.');
      if (cause instanceof JobStoreError && cause.code === 'CORRUPT') return error('INTERNAL_ERROR', 'The stored operation is invalid and was left untouched.');
      return error('INTERNAL_ERROR', 'The operation status could not be read.', true);
    }
  }

  private failed(record: StoredOperation, code: string, message: string, retryable: boolean): PublicOperation {
    return PublicOperationSchema.parse({ operation_id: record.operation_id, kind: record.kind, status: 'failed', created_at: record.created_at, completed_at: this.now().toISOString(), error: { code, message, retryable } });
  }

  private pump(): void {
    while (this.active < MAX_ACTIVE_GENERATIONS && this.queue.length) {
      const job = this.queue.shift()!;
      this.active++;
      void this.execute(job).finally(() => { this.active--; this.pump(); });
    }
  }

  private async execute(job: QueuedJob): Promise<void> {
    const startedAt = Date.now();
    let stored: StoredOperation;
    try { stored = await this.jobs.get(job.operationId, this.now()); }
    catch { return; }
    if (stored.status !== 'pending') return;
    try {
      const first = await this.provider!.generateAdventure({ premise: job.request.premise, locale: job.request.locale, preferences: job.request.preferences });
      let candidate = first;
      let valid = this.validateCandidate(candidate, job.request);
      if (!valid.ok) {
        this.trace({ outcome: 'repair', phase: 'validation', issue_count: valid.issues.length, issue_paths: valid.issues.map(issuePath).slice(0, 40) });
        const repair: AdventureRepairContext = { candidate, issues: valid.issues };
        candidate = await this.provider!.generateAdventure({ premise: job.request.premise, locale: job.request.locale, preferences: job.request.preferences }, repair);
        valid = this.validateCandidate(candidate, job.request);
      }
      if (!valid.ok) {
        this.trace({ outcome: 'failed', phase: 'validation', issue_count: valid.issues.length, issue_paths: valid.issues.map(issuePath).slice(0, 40), elapsed_ms: Date.now() - startedAt });
        await this.jobs.complete(job.operationId, this.failed(stored, 'OPERATION_FAILED', 'The generated adventure failed validation after one repair attempt.', true));
        return;
      }
      const adventure = valid.adventure;
      if (await this.hasAdventure?.(adventure.id, adventure.locale)) {
        await this.jobs.complete(job.operationId, this.failed(stored, 'OPERATION_FAILED', 'The generated adventure ID already exists in this language.', true));
        return;
      }
      await this.persistAdventure(adventure);
      const ready = PublicOperationSchema.parse({
        operation_id: job.operationId, kind: 'prepare_adventure', status: 'ready', created_at: stored.created_at,
        completed_at: this.now().toISOString(), result: { kind: 'adventure', adventure_id: adventure.id, title: adventure.title },
      });
      await this.jobs.complete(job.operationId, ready);
      this.trace({ outcome: 'ready', elapsed_ms: Date.now() - startedAt });
    } catch (cause) {
      const errorCode = cause && typeof cause === 'object' && 'code' in cause && typeof cause.code === 'string'
        ? cause.code.slice(0, 40)
        : cause instanceof Error ? cause.name.slice(0, 40) : 'unknown';
      this.trace({ outcome: 'failed', phase: 'provider_or_storage', error_code: errorCode, elapsed_ms: Date.now() - startedAt });
      try { await this.jobs.complete(job.operationId, this.failed(stored, 'OPERATION_FAILED', 'Adventure generation or validation could not be completed.', true)); }
      catch { /* preserve the durable pending record if storage itself has failed */ }
    }
  }

  private validateCandidate(input: unknown, request: PrepareAdventureRequest): { ok: true; adventure: import('../../shared/adventure-schema.js').AdventureDefinition } | { ok: false; issues: string[] } {
    const result = validateAdventureDefinition(completeMissingChoiceActions(input));
    if (!result.ok) return { ok: false, issues: result.issues.map(({ path, message }) => `${path}: ${message}`) };
    const adventure = result.adventure;
    const issues: string[] = validateGeneratedPlayability(adventure);
    if (adventure.locale !== request.locale) issues.push('locale must match the requested locale');
    if (request.preferences.genre && adventure.genre.toLocaleLowerCase() !== request.preferences.genre.toLocaleLowerCase()) issues.push('genre must match the requested genre');
    if (request.preferences.tone && adventure.tone.toLocaleLowerCase() !== request.preferences.tone.toLocaleLowerCase()) issues.push('tone must match the requested tone');
    if (request.preferences.duration_minutes !== undefined && adventure.duration_minutes > request.preferences.duration_minutes) issues.push('duration must not exceed the requested maximum');
    if (request.preferences.player_count !== undefined && !(adventure.players.min <= request.preferences.player_count && adventure.players.max >= request.preferences.player_count)) issues.push('player range must include the requested group size');
    return issues.length ? { ok: false, issues } : { ok: true, adventure };
  }

  private async persistAdventure(adventure: import('../../shared/adventure-schema.js').AdventureDefinition): Promise<void> {
    await mkdir(this.adventureDir, { recursive: true });
    const filename = path.join(this.adventureDir, `${adventure.id}.${adventure.locale}.json`);
    const temporary = path.join(this.adventureDir, `.${adventure.id}.${adventure.locale}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(adventure, null, 2)}\n`, 'utf8');
      await handle.sync(); await handle.close(); handle = undefined;
      await link(temporary, filename);
    } catch (cause) {
      if (handle) await handle.close().catch(() => undefined);
      if (cause && typeof cause === 'object' && 'code' in cause && cause.code === 'EEXIST') throw new Error('An adventure with the generated ID already exists.');
      throw cause;
    } finally { await unlink(temporary).catch(() => undefined); }
  }
}
