import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { AdventureDefinitionSchema, type AdventureDefinition } from '../../shared/adventure-schema.js';
import {
  EndSessionRequestSchema, GetOperationStatusRequestSchema, GetSessionRequestSchema, ListAdventuresRequestSchema, ListAdventuresResponseSchema,
  PrepareAdventureRequestSchema, ResolveCheckRequestSchema, StartSessionRequestSchema,
  SubmitActionRequestSchema, type ListAdventuresResponse,
} from '../../shared/host-schema.js';
import { PublicErrorSchema, type PersistedSessionV2, type PublicError, type PublicOperation, type PublicTurn } from '../../shared/session-schema.js';
import {
  createInitialSession, endSession, EngineError, getPublicTurn, resolvePendingCheck, submitInteraction,
  type EngineDependencies,
} from './core.js';
import { JsonSessionStore, SessionStoreError } from './store.js';
import { ZodError } from 'zod';
import { AdventurePreparationService } from '../generation/prepare.js';
import type { AdventureGenerationEvent } from '../generation/prepare.js';
import type { AdventureGenerationProvider } from '../generation/provider.js';

export type ServiceResult<T> = T | PublicError;
type AdventureServiceOptions = {
  dataDir: string;
  adventureDir?: string;
  generatedAdventureDir?: string;
  store?: JsonSessionStore;
  engineDependencies?: EngineDependencies;
  generationProvider?: AdventureGenerationProvider;
  generationTrace?: (event: AdventureGenerationEvent) => void;
};

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(command: string, input: Record<string, unknown>): string {
  const { request_id: _requestId, ...payload } = input;
  return `sha256:${createHash('sha256').update(`${command}:${canonical(payload)}`).digest('hex')}`;
}

const GENRE_TRANSLATIONS: Readonly<Record<string, string>> = {
  mystery: 'misterio', misterio: 'mystery',
  cozy: 'acogedor', acogedor: 'cozy', acogedora: 'cozy',
  'cozy mystery': 'misterio acogedor', 'misterio acogedor': 'cozy mystery',
  fantasy: 'fantasia', fantasia: 'fantasy',
  'science fiction': 'ciencia ficcion', 'ciencia ficcion': 'science fiction',
  'sci-fi': 'ciencia ficcion', space: 'espacial', espacial: 'space',
};

function normalizeGenre(value: string): string {
  return value.toLocaleLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
}

function matchesGenre(genre: string, requested: string): boolean {
  const normalizedGenre = normalizeGenre(genre);
  const normalizedRequest = normalizeGenre(requested);
  const translated = GENRE_TRANSLATIONS[normalizedRequest];
  return normalizedGenre.includes(normalizedRequest) || Boolean(translated && normalizedGenre.includes(translated));
}

function publicError(code: PublicError['code'], message: string, retryable = false, currentRevision?: number): PublicError {
  return PublicErrorSchema.parse({ kind: 'error', code, message, retryable, ...(currentRevision === undefined ? {} : { current_revision: currentRevision }) });
}

function mapError(error: unknown): PublicError {
  if (error instanceof ZodError) return publicError('INVALID_INPUT', 'The request does not match the tool input schema.');
  if (error instanceof SessionStoreError) {
    if (error.code === 'NOT_FOUND') return publicError('NOT_FOUND', 'The session was not found.');
    if (error.code === 'UNSUPPORTED_SESSION_VERSION') return publicError('UNSUPPORTED_SESSION_VERSION', 'This session version is not supported.');
    if (error.code === 'INVALID_SESSION') return publicError('INVALID_INPUT', error.message);
    return publicError('INTERNAL_ERROR', 'The session could not be read or saved.');
  }
  if (error instanceof EngineError) {
    if (error.code === 'INVALID_ADVENTURE') return publicError('NOT_FOUND', 'The requested adventure is unavailable.');
    if (error.code === 'ALREADY_ENDED') return publicError('ALREADY_ENDED', error.message);
    if (['CHOICE_NOT_FOUND', 'ACTION_NOT_ALLOWED', 'ITEM_NOT_ALLOWED', 'ITEM_NOT_OWNED', 'CHOICE_UNAVAILABLE', 'CHECK_NOT_PENDING', 'CHECK_ID_MISMATCH'].includes(error.code)) return publicError('INVALID_INPUT', error.message);
    if (error.clarification) return publicError('INVALID_INPUT', error.message, true);
    return publicError('INVALID_INPUT', error.message);
  }
  return publicError('INTERNAL_ERROR', 'The adventure request could not be completed.');
}

export class AdventureService {
  readonly store: JsonSessionStore;
  private readonly adventureDir: string;
  private readonly generatedAdventureDir: string;
  private readonly engineDependencies: EngineDependencies;
  private readonly preparation: AdventurePreparationService;

  constructor(options: AdventureServiceOptions) {
    this.store = options.store ?? new JsonSessionStore(path.join(options.dataDir, 'sessions-v2'));
    this.adventureDir = path.resolve(options.adventureDir ?? path.resolve('adventures'));
    this.generatedAdventureDir = path.resolve(options.generatedAdventureDir ?? path.join(options.dataDir, 'generated-adventures'));
    this.engineDependencies = options.engineDependencies ?? {};
    this.preparation = new AdventurePreparationService({
      dataDir: options.dataDir, adventureDir: this.generatedAdventureDir, provider: options.generationProvider,
      trace: options.generationTrace,
      hasAdventure: async (id, locale) => (await this.adventures()).some((adventure) => adventure.id === id && adventure.locale === locale),
    });
  }

  private async adventures(): Promise<AdventureDefinition[]> {
    const namesByDir = await Promise.all([...new Set([this.adventureDir, this.generatedAdventureDir])].map(async (directory) => {
      try { return (await readdir(directory)).filter((name) => name.endsWith('.json')).map((name) => ({ directory, name })); }
      catch (error) {
        if (directory === this.generatedAdventureDir && error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return [];
        throw error;
      }
    }));
    const found: AdventureDefinition[] = [];
    for (const { directory, name } of namesByDir.flat().sort((a, b) => `${a.directory}/${a.name}`.localeCompare(`${b.directory}/${b.name}`))) {
      const raw: unknown = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
      found.push(AdventureDefinitionSchema.parse(raw));
    }
    return found;
  }

  private async findAdventure(id: string, locale: string): Promise<AdventureDefinition> {
    const definition = (await this.adventures()).find((item) => item.id === id && item.locale === locale);
    if (!definition) throw new EngineError('INVALID_ADVENTURE', 'The requested adventure is unavailable in that language.');
    return definition;
  }

  async listAdventures(input: unknown): Promise<ServiceResult<ListAdventuresResponse>> {
    try {
      const query = ListAdventuresRequestSchema.parse(input);
      const filtered = (await this.adventures()).filter((adventure) =>
        (!query.locale || adventure.locale === query.locale)
        && (!query.genre || matchesGenre(adventure.genre, query.genre))
        && (query.players === undefined || (adventure.players.min <= query.players && adventure.players.max >= query.players))
        && (query.duration_minutes === undefined || adventure.duration_minutes <= query.duration_minutes));
      return ListAdventuresResponseSchema.parse({ adventures: filtered.map(({ id, version, title, locale, genre, tone, duration_minutes, players, objective }) => ({ id, version, title, locale, genre, tone, duration_minutes, players, objective })) });
    } catch (error) { return mapError(error); }
  }

  async prepareAdventure(input: unknown): Promise<ServiceResult<PublicOperation>> {
    try { return await this.preparation.prepare(PrepareAdventureRequestSchema.parse(input)); }
    catch (error) { return mapError(error); }
  }

  async getOperationStatus(input: unknown): Promise<ServiceResult<PublicOperation>> {
    try { return await this.preparation.getStatus(GetOperationStatusRequestSchema.parse(input)); }
    catch (error) { return mapError(error); }
  }

  async startSession(input: unknown): Promise<ServiceResult<PublicTurn>> {
    try {
      const request = StartSessionRequestSchema.parse(input);
      const requestFingerprint = fingerprint('start_session', request as unknown as Record<string, unknown>);
      // The request UUID is also the session UUID. Check its durable record before doing any work.
      try {
        const prior = await this.store.getSession(request.request_id);
        const record = prior.idempotency_records.find((item) => item.request_id === request.request_id);
        if (record?.command === 'start_session' && record.input_fingerprint === requestFingerprint && record.result.kind === 'turn') return record.result.turn;
        return publicError('IDEMPOTENCY_KEY_REUSED', 'request_id was already used for a different start request.');
      } catch (error) {
        if (!(error instanceof SessionStoreError) || error.code !== 'NOT_FOUND') throw error;
      }
      const definition = await this.findAdventure(request.adventure_id, request.locale);
      const created = createInitialSession(definition, { sessionId: request.request_id, requestId: request.request_id, players: request.players }, this.engineDependencies);
      const session: PersistedSessionV2 = {
        ...created.session,
        idempotency_records: [{ request_id: request.request_id, command: 'start_session', input_fingerprint: requestFingerprint, result: { kind: 'turn', turn: created.turn } }],
      };
      try { await this.store.createSession(session); return created.turn; }
      catch (error) {
        if (error instanceof SessionStoreError && error.code === 'ALREADY_EXISTS') {
          const prior = await this.store.getSession(request.request_id);
          const record = prior.idempotency_records.find((item) => item.request_id === request.request_id);
          if (record?.command === 'start_session' && record.input_fingerprint === requestFingerprint && record.result.kind === 'turn') return record.result.turn;
          return publicError('IDEMPOTENCY_KEY_REUSED', 'request_id was already used for a different start request.');
        }
        throw error;
      }
    } catch (error) { return mapError(error); }
  }

  async getSession(input: unknown): Promise<ServiceResult<PublicTurn>> {
    try {
      const request = GetSessionRequestSchema.parse(input);
      const session = await this.store.getSession(request.session_id);
      const definition = await this.findAdventure(session.adventure_id, session.adventure_locale);
      return getPublicTurn(definition, session);
    } catch (error) { return mapError(error); }
  }

  private async mutate(input: unknown, command: 'submit_action' | 'resolve_check' | 'end_session'): Promise<ServiceResult<PublicTurn>> {
    try {
      const schema = command === 'submit_action' ? SubmitActionRequestSchema : command === 'resolve_check' ? ResolveCheckRequestSchema : EndSessionRequestSchema;
      const request = schema.parse(input) as Record<string, unknown> & { session_id: string; request_id: string; expected_revision: number };
      const session = await this.store.getSession(request.session_id);
      const definition = await this.findAdventure(session.adventure_id, session.adventure_locale);
      const result = await this.store.mutateSession(request.session_id, {
        request_id: request.request_id, command,
        input_fingerprint: fingerprint(command, request), expected_revision: request.expected_revision,
      }, (current) => {
        const execution = command === 'submit_action'
          ? submitInteraction(definition, current, request.interaction as Parameters<typeof submitInteraction>[2], { requestId: request.request_id }, this.engineDependencies)
          : command === 'resolve_check'
            ? resolvePendingCheck(definition, current, { checkId: request.check_id as string, requestId: request.request_id }, this.engineDependencies)
            : endSession(definition, current, { requestId: request.request_id }, this.engineDependencies);
        return { session: execution.session, response: { kind: 'turn', turn: execution.turn } };
      });
      return result.response.kind === 'turn' ? result.response.turn : result.response;
    } catch (error) { return mapError(error); }
  }

  submitAction(input: unknown) { return this.mutate(input, 'submit_action'); }
  resolveCheck(input: unknown) { return this.mutate(input, 'resolve_check'); }
  endSession(input: unknown) { return this.mutate(input, 'end_session'); }
}
