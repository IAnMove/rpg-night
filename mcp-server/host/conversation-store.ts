import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { AdventureIdSchema } from '../../shared/adventure-schema.js';
import { AdventureSummarySchema, HostConversationSchema, HostResponseSchema } from '../../shared/host-schema.js';
import { PublicTurnSchema, SessionIdSchema } from '../../shared/session-schema.js';

const HistoryEntrySchema = z.object({ role: z.enum(['user', 'assistant']), content: z.string().min(1).max(2000) }).strict();
const IdempotencyEntrySchema = z.object({ request_id: z.string().uuid(), fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/), response: HostResponseSchema }).strict();
export const PersistedConversationSchema = z.object({
  schema_version: z.literal(1),
  conversation: HostConversationSchema,
  create_fingerprint: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  session_id: SessionIdSchema.nullable(),
  turn: PublicTurnSchema.nullable(),
  public_turns: z.array(PublicTurnSchema).max(40).default([]),
  player_names: z.array(z.string().trim().min(1).max(32)).max(6),
  catalogue: z.array(AdventureSummarySchema).max(200),
  offered_adventure_ids: z.array(AdventureIdSchema).max(200),
  history: z.array(HistoryEntrySchema).max(24),
  summary: z.string().max(1200),
  paused: z.boolean(),
  idempotency: z.array(IdempotencyEntrySchema).max(100),
  updated_at: z.string().datetime(),
}).strict().superRefine((record, ctx) => {
  if ((record.session_id === null) !== (record.turn === null)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['turn'], message: 'session_id and turn must be present together' });
  if (record.turn && record.turn.session_id !== record.session_id) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['turn', 'session_id'], message: 'turn must belong to linked session' });
  if (record.public_turns.some((turn) => turn.session_id !== record.session_id || turn.locale !== record.conversation.locale)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['public_turns'], message: 'public history must belong to the linked session and locale' });
  if (record.turn && record.public_turns.length && record.public_turns.at(-1)?.revision !== record.turn.revision) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['public_turns'], message: 'public history must end at the current turn revision' });
  if (record.turn && record.turn.phase !== 'ended' && record.turn.revision < 1) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['turn', 'revision'], message: 'active session revision must be positive' });
  const keys = record.idempotency.map(({ request_id }) => request_id);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['idempotency'], message: 'duplicate request IDs are not allowed' });
  if (record.offered_adventure_ids.some((id) => !record.catalogue.some((adventure) => adventure.id === id && adventure.locale === record.conversation.locale))) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['offered_adventure_ids'], message: 'only adventures in the current locale catalogue can be offered' });
});
export type PersistedConversation = z.infer<typeof PersistedConversationSchema>;

export class ConversationStoreError extends Error {
  constructor(readonly code: 'NOT_FOUND' | 'CORRUPT' | 'ALREADY_EXISTS' | 'INVALID', message: string, options?: ErrorOptions) {
    super(message, options); this.name = 'ConversationStoreError';
  }
}

type Queue = { tail: Promise<void>; users: number };
const locks = new Map<string, Queue>();
async function exclusive<T>(key: string, work: () => Promise<T>): Promise<T> {
  const queue = locks.get(key) ?? { tail: Promise.resolve(), users: 0 };
  queue.users++; locks.set(key, queue);
  const previous = queue.tail;
  let release!: () => void;
  queue.tail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try { return await work(); }
  finally { release(); if (--queue.users === 0 && locks.get(key) === queue) locks.delete(key); }
}

export function hostFingerprint(value: unknown): string {
  const canonicalize = (input: unknown): string => {
    if (Array.isArray(input)) return `[${input.map(canonicalize).join(',')}]`;
    if (input && typeof input === 'object') return `{${Object.entries(input as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalize(child)}`).join(',')}}`;
    return JSON.stringify(input);
  };
  return `sha256:${createHash('sha256').update(canonicalize(value)).digest('hex')}`;
}

export class JsonConversationStore {
  readonly directory: string;
  constructor(directory: string) { this.directory = path.resolve(directory); }
  private file(id: string) {
    if (!z.string().uuid().safeParse(id).success) throw new ConversationStoreError('INVALID', 'Conversation ID must be a UUID.');
    return path.join(this.directory, `${id}.json`);
  }
  private async readFile(file: string, id: string): Promise<PersistedConversation> {
    let raw: unknown;
    try { raw = JSON.parse(await readFile(file, 'utf8')) as unknown; }
    catch (error) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') throw new ConversationStoreError('NOT_FOUND', 'Conversation not found.', { cause: error });
      throw new ConversationStoreError('CORRUPT', 'Saved conversation is unreadable; it was left untouched.', { cause: error });
    }
    const parsed = PersistedConversationSchema.safeParse(raw);
    if (!parsed.success || parsed.data.conversation.conversation_id !== id) throw new ConversationStoreError('CORRUPT', 'Saved conversation is incompatible; it was left untouched.', { cause: parsed.success ? undefined : parsed.error });
    return parsed.data;
  }
  async get(id: string): Promise<PersistedConversation> { return this.readFile(this.file(id), id); }
  async create(recordInput: PersistedConversation): Promise<PersistedConversation> {
    const record = PersistedConversationSchema.parse(recordInput);
    const id = record.conversation.conversation_id, filename = this.file(id);
    return exclusive(filename, async () => {
      await mkdir(this.directory, { recursive: true });
      try { await access(filename); throw new ConversationStoreError('ALREADY_EXISTS', 'Conversation already exists.'); }
      catch (error) { if (error instanceof ConversationStoreError) throw error; if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error; }
      await this.writeAtomic(record, filename);
      return record;
    });
  }
  async update<T>(id: string, mutate: (current: PersistedConversation) => Promise<{ record: PersistedConversation; value: T }> | { record: PersistedConversation; value: T }): Promise<T> {
    const filename = this.file(id);
    return exclusive(filename, async () => {
      const current = await this.readFile(filename, id);
      const { record: next, value } = await mutate(current);
      const checked = PersistedConversationSchema.parse(next);
      if (checked.conversation.conversation_id !== id || checked.conversation.created_at !== current.conversation.created_at) throw new ConversationStoreError('INVALID', 'Conversation identity is immutable.');
      await this.writeAtomic(checked, filename);
      return value;
    });
  }
  private async writeAtomic(record: PersistedConversation, filename: string): Promise<void> {
    const temporary = path.join(this.directory, `.${record.conversation.conversation_id}.${randomUUID()}.tmp`);
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
