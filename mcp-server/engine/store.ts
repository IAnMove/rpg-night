import { randomUUID } from 'node:crypto';
import { access, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import {
  PersistedSessionV2Schema,
  PublicErrorSchema,
  RequestIdSchema,
  SessionIdSchema,
  type PersistedSessionV2,
  type PublicError,
} from '../../shared/session-schema.js';

export type SessionMutationCommand = PersistedSessionV2['idempotency_records'][number]['command'];
export type SessionMutationResponse = Extract<PersistedSessionV2['idempotency_records'][number]['result'], { kind: 'turn' }>;

export type SessionMutationContext = {
  request_id: string;
  command: SessionMutationCommand;
  input_fingerprint: string;
  expected_revision: number;
};

export type SessionMutationExecution = {
  session: PersistedSessionV2;
  response: SessionMutationResponse;
};

export type SessionMutationResult =
  | { disposition: 'executed' | 'replayed'; session: PersistedSessionV2; response: SessionMutationResponse }
  | { disposition: 'rejected'; session: PersistedSessionV2; response: PublicError };

export type SessionStoreErrorCode = 'NOT_FOUND' | 'ALREADY_EXISTS' | 'CORRUPT_SESSION' | 'UNSUPPORTED_SESSION_VERSION' | 'INVALID_SESSION';

export class SessionStoreError extends Error {
  constructor(readonly code: SessionStoreErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SessionStoreError';
  }
}

type LockEntry = { tail: Promise<void>; users: number };
const processLocks = new Map<string, LockEntry>();

async function withSessionLock<T>(key: string, run: () => Promise<T>): Promise<T> {
  const entry = processLocks.get(key) ?? { tail: Promise.resolve(), users: 0 };
  entry.users += 1;
  processLocks.set(key, entry);
  const prior = entry.tail;
  let release!: () => void;
  entry.tail = new Promise<void>((resolve) => { release = resolve; });
  await prior;
  try {
    return await run();
  } finally {
    release();
    entry.users -= 1;
    if (entry.users === 0 && processLocks.get(key) === entry) processLocks.delete(key);
  }
}

function errorResponse(code: PublicError['code'], message: string, retryable: boolean, currentRevision?: number): PublicError {
  return PublicErrorSchema.parse({
    kind: 'error', code, message, retryable,
    ...(currentRevision === undefined ? {} : { current_revision: currentRevision }),
  });
}

/**
 * File-backed v2 session store. Files live only in the supplied v2 directory;
 * legacy game JSON is never read, migrated, replaced, or removed here.
 * Locking is serialized across store instances in this Node process.
 */
export class JsonSessionStore {
  readonly directory: string;

  constructor(directory = path.resolve('data', 'sessions-v2')) {
    this.directory = path.resolve(directory);
  }

  private filePath(sessionId: string): string {
    const parsed = SessionIdSchema.safeParse(sessionId);
    if (!parsed.success) throw new SessionStoreError('INVALID_SESSION', 'Session ID must be a UUID.');
    return path.join(this.directory, `${parsed.data}.json`);
  }

  private lockKey(sessionId: string): string {
    return this.filePath(sessionId);
  }

  private async readFileSession(filename: string, sessionId: string): Promise<PersistedSessionV2> {
    let source: string;
    try {
      source = await readFile(filename, 'utf8');
    } catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
        throw new SessionStoreError('NOT_FOUND', `Session ${sessionId} does not exist.`, { cause: error });
      }
      throw error;
    }

    let raw: unknown;
    try {
      raw = JSON.parse(source) as unknown;
    } catch (error) {
      throw new SessionStoreError('CORRUPT_SESSION', `Session ${sessionId} contains invalid JSON; it was left untouched.`, { cause: error });
    }
    if (typeof raw !== 'object' || raw === null || !('schema_version' in raw) || raw.schema_version !== 2) {
      throw new SessionStoreError('UNSUPPORTED_SESSION_VERSION', `Session ${sessionId} is not a v2 record; it was left untouched.`);
    }
    const parsed = PersistedSessionV2Schema.safeParse(raw);
    if (!parsed.success) {
      throw new SessionStoreError('CORRUPT_SESSION', `Session ${sessionId} does not satisfy the v2 schema; it was left untouched.`, { cause: parsed.error });
    }
    if (parsed.data.session_id !== sessionId) {
      throw new SessionStoreError('CORRUPT_SESSION', `Session file ${sessionId} contains a different session ID; it was left untouched.`);
    }
    const requestIds = parsed.data.idempotency_records.map(({ request_id }) => request_id);
    if (new Set(requestIds).size !== requestIds.length) {
      throw new SessionStoreError('CORRUPT_SESSION', `Session ${sessionId} contains duplicate idempotency keys; it was left untouched.`);
    }
    return parsed.data;
  }

  private async writeAtomic(session: PersistedSessionV2, createOnly: boolean): Promise<void> {
    const filename = this.filePath(session.session_id);
    const parsed = PersistedSessionV2Schema.safeParse(session);
    if (!parsed.success) throw new SessionStoreError('INVALID_SESSION', `Refusing to store an invalid v2 session: ${parsed.error.message}`);
    const requestIds = parsed.data.idempotency_records.map(({ request_id }) => request_id);
    if (new Set(requestIds).size !== requestIds.length) {
      throw new SessionStoreError('INVALID_SESSION', 'Refusing to store duplicate idempotency keys.');
    }
    await mkdir(this.directory, { recursive: true });
    const temporary = path.join(this.directory, `.${session.session_id}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(parsed.data, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      if (createOnly) {
        // The per-session process lock prevents competing creates in this server.
        // Atomic rename then publishes the fully synced file in one operation.
        try {
          await access(filename);
          throw new SessionStoreError('ALREADY_EXISTS', `Session ${session.session_id} already exists.`);
        } catch (error) {
          if (error instanceof SessionStoreError) throw error;
          if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'ENOENT') throw error;
        }
        await rename(temporary, filename);
      } else {
        await rename(temporary, filename);
      }
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      if (error instanceof SessionStoreError) throw error;
      if (createOnly && typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST') {
        throw new SessionStoreError('ALREADY_EXISTS', `Session ${session.session_id} already exists.`, { cause: error });
      }
      throw error;
    }
  }

  async createSession(input: PersistedSessionV2): Promise<PersistedSessionV2> {
    const session = PersistedSessionV2Schema.parse(input);
    return withSessionLock(this.lockKey(session.session_id), async () => {
      await this.writeAtomic(session, true);
      return session;
    });
  }

  async getSession(sessionId: string): Promise<PersistedSessionV2> {
    const filename = this.filePath(sessionId);
    return this.readFileSession(filename, sessionId);
  }

  /**
   * Idempotency is checked before the revision. `execute` must be pure with
   * respect to external publication: it returns a candidate session and the
   * public turn; this store commits both state and replay record before callers
   * publish that response.
   */
  async mutateSession(
    sessionId: string,
    context: SessionMutationContext,
    execute: (current: PersistedSessionV2) => Promise<SessionMutationExecution> | SessionMutationExecution,
  ): Promise<SessionMutationResult> {
    const filename = this.filePath(sessionId);
    const requestId = RequestIdSchema.safeParse(context.request_id);
    if (!requestId.success) throw new SessionStoreError('INVALID_SESSION', 'request_id must be a UUID.');
    if (!Number.isInteger(context.expected_revision) || context.expected_revision < 0) {
      throw new SessionStoreError('INVALID_SESSION', 'expected_revision must be a non-negative integer.');
    }
    if (typeof context.input_fingerprint !== 'string' || context.input_fingerprint.length < 1 || context.input_fingerprint.length > 128) {
      throw new SessionStoreError('INVALID_SESSION', 'input_fingerprint must contain 1 to 128 characters.');
    }
    if (!['submit_action', 'resolve_check', 'end_session', 'pause', 'resume'].includes(context.command)) {
      throw new SessionStoreError('INVALID_SESSION', 'Unknown session mutation command.');
    }

    return withSessionLock(this.lockKey(sessionId), async () => {
      const current = await this.readFileSession(filename, sessionId);
      const previous = current.idempotency_records.find((record) => record.request_id === requestId.data);
      if (previous) {
        if (previous.command !== context.command || previous.input_fingerprint !== context.input_fingerprint) {
          return {
            disposition: 'rejected',
            session: current,
            response: errorResponse('IDEMPOTENCY_KEY_REUSED', 'request_id was already used for a different command or input.', false, current.revision),
          };
        }
        const parsedResponse = previous.result;
        if (parsedResponse.kind !== 'turn') {
          throw new SessionStoreError('CORRUPT_SESSION', 'A stored successful mutation has no replayable turn response.');
        }
        return { disposition: 'replayed', session: current, response: parsedResponse };
      }

      if (current.revision !== context.expected_revision) {
        return {
          disposition: 'rejected',
          session: current,
          response: errorResponse('REVISION_CONFLICT', 'The session has changed since this action was prepared.', true, current.revision),
        };
      }

      const execution = await execute(current);
      const candidate = PersistedSessionV2Schema.safeParse(execution.session);
      if (!candidate.success) throw new SessionStoreError('INVALID_SESSION', `Mutation returned an invalid session: ${candidate.error.message}`);
      if (candidate.data.session_id !== current.session_id
        || candidate.data.adventure_id !== current.adventure_id
        || candidate.data.adventure_version !== current.adventure_version
        || candidate.data.adventure_locale !== current.adventure_locale) {
        throw new SessionStoreError('INVALID_SESSION', 'A session mutation cannot change session or adventure identity.');
      }
      if (candidate.data.revision !== current.revision + 1) {
        throw new SessionStoreError('INVALID_SESSION', 'A successful session mutation must increment revision exactly once.');
      }
      if (execution.response.kind !== 'turn'
        || execution.response.turn.session_id !== sessionId
        || execution.response.turn.revision !== candidate.data.revision
        || execution.response.turn.view_revision !== candidate.data.view_revision
        || execution.response.turn.phase !== candidate.data.phase
        || execution.response.turn.scene_id !== candidate.data.current_node_id) {
        throw new SessionStoreError('INVALID_SESSION', 'The mutation response must be a turn for the committed session revision.');
      }

      const committed = PersistedSessionV2Schema.parse({
        ...candidate.data,
        idempotency_records: [...current.idempotency_records, {
          request_id: requestId.data,
          command: context.command,
          input_fingerprint: context.input_fingerprint,
          result: execution.response,
        }],
      });
      await this.writeAtomic(committed, false);
      return { disposition: 'executed', session: committed, response: execution.response };
    });
  }
}
