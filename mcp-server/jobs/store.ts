import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { RequestIdSchema, StoredOperationSchema, type PublicOperation, type StoredOperation } from '../../shared/session-schema.js';

type Lock = { tail: Promise<void>; users: number };
const locks = new Map<string, Lock>();

async function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
  const lock = locks.get(key) ?? { tail: Promise.resolve(), users: 0 };
  lock.users++; locks.set(key, lock);
  const prior = lock.tail;
  let release!: () => void;
  lock.tail = new Promise<void>((resolve) => { release = resolve; });
  await prior;
  try { return await work(); }
  finally { release(); if (--lock.users === 0 && locks.get(key) === lock) locks.delete(key); }
}

export class JobStoreError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'CORRUPT' | 'IDEMPOTENCY_KEY_REUSED' | 'INVALID', message: string, options?: ErrorOptions) {
    super(message, options); this.name = 'JobStoreError';
  }
}

/** File-backed durable operation registry. Records are private; callers receive only PublicOperation. */
export class JsonJobStore {
  readonly directory: string;
  constructor(directory: string) { this.directory = path.resolve(directory); }

  private file(operationId: string): string {
    if (!RequestIdSchema.safeParse(operationId).success) throw new JobStoreError('INVALID', 'operation_id must be a UUID.');
    return path.join(this.directory, `${operationId}.json`);
  }

  private async read(filename: string, operationId: string): Promise<StoredOperation> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(filename, 'utf8')) as unknown; }
    catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') throw new JobStoreError('NOT_FOUND', 'Operation not found.', { cause: error });
      throw new JobStoreError('CORRUPT', 'Operation record is unreadable and was left untouched.', { cause: error });
    }
    const parsed = StoredOperationSchema.safeParse(raw);
    if (!parsed.success || parsed.data.operation_id !== operationId) throw new JobStoreError('CORRUPT', 'Operation record is invalid or incompatible and was left untouched.', { cause: parsed.success ? undefined : parsed.error });
    return parsed.data;
  }

  async createPending(recordInput: StoredOperation): Promise<{ created: boolean; record: StoredOperation }> {
    const record = StoredOperationSchema.parse(recordInput);
    if (record.status !== 'pending' || record.kind !== 'prepare_adventure') throw new JobStoreError('INVALID', 'Only pending preparation operations can be created.');
    const filename = this.file(record.operation_id);
    return exclusive(filename, async () => {
      await mkdir(this.directory, { recursive: true });
      try {
        const prior = await this.read(filename, record.operation_id);
        if (prior.request_id !== record.request_id || prior.input_fingerprint !== record.input_fingerprint) throw new JobStoreError('IDEMPOTENCY_KEY_REUSED', 'request_id was already used for a different preparation.');
        if (prior.status === 'pending' && Date.parse(prior.expires_at) <= Date.now()) {
          const expired = this.failed(prior, new Date(), 'OPERATION_FAILED', 'The preparation expired before it completed.', true);
          await this.writeAtomic(expired, filename);
          return { created: false, record: expired };
        }
        return { created: false, record: prior };
      } catch (error) {
        if (!(error instanceof JobStoreError) || error.code !== 'NOT_FOUND') throw error;
      }
      await this.writeAtomic(record, filename);
      return { created: true, record };
    });
  }

  async get(operationId: string, now = new Date()): Promise<StoredOperation> {
    const filename = this.file(operationId);
    return exclusive(filename, async () => {
      const current = await this.read(filename, operationId);
      if (current.status !== 'pending' || Date.parse(current.expires_at) > now.getTime()) return current;
      const failed = this.failed(current, now, 'OPERATION_FAILED', 'The preparation expired before it completed.', true);
      await this.writeAtomic(failed, filename);
      return failed;
    });
  }

  async complete(operationId: string, publicResult: PublicOperation): Promise<StoredOperation> {
    const filename = this.file(operationId);
    return exclusive(filename, async () => {
      const current = await this.read(filename, operationId);
      if (current.status !== 'pending') return current;
      if (publicResult.operation_id !== operationId || publicResult.kind !== current.kind || publicResult.status === 'pending') throw new JobStoreError('INVALID', 'Terminal operation result does not match its pending record.');
      const next = StoredOperationSchema.parse({ ...current, status: publicResult.status, public_result: publicResult });
      await this.writeAtomic(next, filename);
      return next;
    });
  }

  async list(): Promise<StoredOperation[]> {
    let names: string[];
    try { names = (await readdir(this.directory)).filter((name) => /^[0-9a-f-]{36}\.json$/i.test(name)).sort(); }
    catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return [];
      throw error;
    }
    return Promise.all(names.map((name) => this.read(path.join(this.directory, name), name.slice(0, -5))));
  }

  /** An interrupted in-process job is explicitly failed at startup, never left pending forever. */
  async failInterrupted(now = new Date()): Promise<void> {
    const records = await this.list();
    for (const record of records) {
      if (record.status !== 'pending') continue;
      await this.complete(record.operation_id, {
        operation_id: record.operation_id, kind: record.kind, status: 'failed',
        created_at: record.created_at, completed_at: now.toISOString(),
        error: { code: 'OPERATION_FAILED', message: 'The preparation was interrupted by a server restart. Submit a new request to try again.', retryable: true },
      });
    }
  }

  toPublic(record: StoredOperation): PublicOperation {
    if (record.public_result) return record.public_result;
    return { operation_id: record.operation_id, kind: record.kind, status: 'pending', created_at: record.created_at, expires_at: record.expires_at };
  }

  private failed(record: StoredOperation, now: Date, code: string, message: string, retryable: boolean): StoredOperation {
    const result: PublicOperation = { operation_id: record.operation_id, kind: record.kind, status: 'failed', created_at: record.created_at, completed_at: now.toISOString(), error: { code, message, retryable } };
    return StoredOperationSchema.parse({ ...record, status: 'failed', public_result: result });
  }

  private async writeAtomic(record: StoredOperation, filename: string): Promise<void> {
    const temporary = path.join(this.directory, `.${record.operation_id}.${randomUUID()}.tmp`);
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
      await handle.sync(); await handle.close(); handle = undefined;
      await rename(temporary, filename);
    } catch (error) {
      if (handle) await handle.close().catch(() => undefined);
      await unlink(temporary).catch(() => undefined);
      throw error;
    }
  }
}
