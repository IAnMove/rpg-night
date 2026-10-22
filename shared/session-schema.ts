import { z } from 'zod';
import { AdventureIdSchema, AdventureLocaleSchema, ContentIdSchema, SceneAffordanceSchema } from './adventure-schema.js';

export const SessionIdSchema = z.string().uuid();
export const RequestIdSchema = z.string().uuid();
export const RevisionSchema = z.number().int().nonnegative();

export const PublicChoiceSchema = z.object({ id: ContentIdSchema, label: z.string().min(1).max(100) }).strict();
export const PublicAffordanceSchema = SceneAffordanceSchema;
export type PublicAffordance = z.infer<typeof PublicAffordanceSchema>;
export const PublicItemSchema = z.object({
  id: ContentIdSchema,
  name: z.string().min(1).max(80),
  description: z.string().max(240),
}).strict();
export type PublicItem = z.infer<typeof PublicItemSchema>;

export const PublicCheckSchema = z.object({
  id: ContentIdSchema,
  kind: z.literal('d20'),
  difficulty_class: z.number().int().min(2).max(20),
  prompt: z.string().min(1).max(240),
}).strict();
export type PublicCheck = z.infer<typeof PublicCheckSchema>;

export const PublicOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('action'), action_label: z.string().min(1).max(240), summary: z.string().min(1).max(1600) }).strict(),
  z.object({ kind: z.literal('check'), check_id: ContentIdSchema, sides: z.literal(20), total: z.number().int().min(1).max(20), difficulty_class: z.number().int().min(2).max(20), result: z.enum(['success', 'setback']), summary: z.string().min(1).max(1600) }).strict(),
  z.object({ kind: z.literal('ending'), ending_id: ContentIdSchema, summary: z.string().min(1).max(1600) }).strict(),
]);
export type PublicOutcome = z.infer<typeof PublicOutcomeSchema>;

export const TurnPhaseSchema = z.enum(['awaiting_choice', 'awaiting_check', 'busy', 'paused', 'ended']);
export const VisualStatusSchema = z.enum(['pending', 'ready', 'failed']);

export const PublicTurnSchema = z.object({
  schema_version: z.literal(2),
  session_id: SessionIdSchema,
  locale: AdventureLocaleSchema,
  revision: RevisionSchema,
  /** Orders all view updates, including art readiness that does not mutate game state. */
  view_revision: RevisionSchema,
  phase: TurnPhaseSchema,
  scene_id: ContentIdSchema,
  narration: z.string().max(1600),
  choices: z.array(PublicChoiceSchema).max(3),
  affordances: z.array(PublicAffordanceSchema).max(16),
  pending_check: z.union([PublicCheckSchema, z.null()]),
  recent_outcome: z.union([PublicOutcomeSchema, z.null()]),
  inventory: z.array(PublicItemSchema).max(40),
  recap: z.string().max(1200),
  next_expected_input: z.string().max(240),
  visual_status: VisualStatusSchema,
}).strict().superRefine((turn, ctx) => {
  if (turn.phase === 'awaiting_choice' && turn.choices.length > 3) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['choices'], message: 'awaiting_choice allows at most three choices' });
  }
  if (turn.phase === 'awaiting_choice' && turn.choices.length === 0 && turn.affordances.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['choices'], message: 'awaiting_choice requires at least one available choice or affordance' });
  }
  if (turn.phase === 'awaiting_check' && turn.pending_check === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pending_check'], message: 'awaiting_check requires a pending check' });
  }
  if (turn.phase === 'awaiting_check' && turn.choices.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['choices'], message: 'awaiting_check cannot expose choices before resolution' });
  }
  if (turn.phase !== 'awaiting_check' && turn.pending_check !== null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pending_check'], message: 'pending check is only valid in awaiting_check phase' });
  }
  if (['busy', 'paused', 'ended'].includes(turn.phase) && turn.choices.length > 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['choices'], message: `${turn.phase} phase must not expose actionable choices` });
  }
  if (turn.phase === 'ended' && turn.next_expected_input !== '') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['next_expected_input'], message: 'ended phase has no next player input' });
  }
});
export type PublicTurn = z.infer<typeof PublicTurnSchema>;

export const OperationKindSchema = z.enum(['prepare_adventure', 'generate_art']);
export const OperationStatusSchema = z.enum(['pending', 'ready', 'failed']);
export const PublicOperationSchema = z.discriminatedUnion('status', [
  z.object({
    operation_id: RequestIdSchema,
    kind: OperationKindSchema,
    status: z.literal('pending'),
    created_at: z.string().datetime(),
    expires_at: z.string().datetime(),
  }).strict(),
  z.object({
    operation_id: RequestIdSchema,
    kind: OperationKindSchema,
    status: z.literal('ready'),
    created_at: z.string().datetime(),
    completed_at: z.string().datetime(),
    result: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('adventure'), adventure_id: AdventureIdSchema, title: z.string().min(1).max(120) }).strict(),
      z.object({ kind: z.literal('turn'), turn: PublicTurnSchema }).strict(),
      z.object({ kind: z.literal('image'), image_url: z.string().url() }).strict(),
    ]),
  }).strict(),
  z.object({
    operation_id: RequestIdSchema,
    kind: OperationKindSchema,
    status: z.literal('failed'),
    created_at: z.string().datetime(),
    completed_at: z.string().datetime(),
    error: z.object({ code: z.string().min(1).max(80), message: z.string().min(1).max(300), retryable: z.boolean() }).strict(),
  }).strict(),
]);
export type PublicOperation = z.infer<typeof PublicOperationSchema>;

export const PublicErrorCodeSchema = z.enum([
  'INVALID_INPUT', 'NOT_FOUND', 'REVISION_CONFLICT', 'IDEMPOTENCY_KEY_REUSED', 'ALREADY_ENDED', 'OPERATION_PENDING',
  'OPERATION_FAILED', 'UNSUPPORTED_SESSION_VERSION', 'INTERNAL_ERROR',
]);
export const PublicErrorSchema = z.object({
  kind: z.literal('error'),
  code: PublicErrorCodeSchema,
  message: z.string().min(1).max(300),
  retryable: z.boolean(),
  current_revision: RevisionSchema.optional(),
  operation: PublicOperationSchema.optional(),
}).strict();
export type PublicError = z.infer<typeof PublicErrorSchema>;

/** The legacy v1 record shape is recognized for an explicit incompatibility response, never migrated implicitly. */
export const LegacySessionV1Schema = z.object({
  id: SessionIdSchema,
  revision: RevisionSchema,
  world: z.enum(['fantasy', 'space', 'mystery']),
  language: z.enum(['en', 'es']),
  status: z.enum(['active', 'ended']),
  scenes: z.array(z.unknown()),
}).passthrough();
export type LegacySessionV1 = z.infer<typeof LegacySessionV1Schema>;

/** Private pending server check. Its transition remains in the versioned adventure. */
export const PendingCheckStateSchema = z.object({
  id: ContentIdSchema,
  choice_id: ContentIdSchema,
  created_at: z.string().datetime(),
}).strict();
export type PendingCheckState = z.infer<typeof PendingCheckStateSchema>;

export const SessionEventSchema = z.object({
  revision: RevisionSchema,
  request_id: z.union([RequestIdSchema, z.null()]),
  kind: z.enum(['started', 'action', 'check', 'paused', 'resumed', 'ended']),
  node_id: ContentIdSchema,
  choice_id: z.union([ContentIdSchema, z.null()]),
  action_text: z.union([z.string().max(1200), z.null()]),
  affordance_id: z.union([ContentIdSchema, z.null()]),
  target_id: z.union([ContentIdSchema, z.null()]),
  item_id: z.union([ContentIdSchema, z.null()]),
  approach_id: z.union([ContentIdSchema, z.null()]),
  check_total: z.union([z.number().int().min(1).max(20), z.null()]),
  outcome: z.union([z.enum(['success', 'setback']), z.null()]),
  occurred_at: z.string().datetime(),
}).strict();
export type SessionEvent = z.infer<typeof SessionEventSchema>;

/** Private v2 save record contract; public projections must still use PublicTurnSchema. */
export const PersistedSessionV2Schema = z.object({
  schema_version: z.literal(2),
  session_id: SessionIdSchema,
  revision: RevisionSchema,
  view_revision: RevisionSchema,
  adventure_id: AdventureIdSchema,
  adventure_version: z.number().int().positive(),
  adventure_locale: AdventureLocaleSchema,
  players: z.array(z.string().trim().min(1).max(32)).min(1).max(6),
  phase: TurnPhaseSchema,
  resume_phase: z.enum(['awaiting_choice', 'awaiting_check']).nullable(),
  pending_check: z.union([PendingCheckStateSchema, z.null()]),
  recent_outcome: z.union([PublicOutcomeSchema, z.null()]),
  recap: z.string().max(1200),
  current_node_id: ContentIdSchema,
  variables: z.record(ContentIdSchema, z.number().finite()),
  inventory: z.array(ContentIdSchema),
  event_log: z.array(SessionEventSchema),
  idempotency_records: z.array(z.object({
    request_id: RequestIdSchema,
    command: z.enum(['start_session', 'submit_action', 'resolve_check', 'end_session', 'pause', 'resume']),
    input_fingerprint: z.string().min(1).max(128),
    result: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('turn'), turn: PublicTurnSchema }).strict(),
      z.object({ kind: z.literal('operation'), operation: PublicOperationSchema }).strict(),
      PublicErrorSchema,
    ]),
  }).strict()),
  updated_at: z.string().datetime(),
}).strict().superRefine((session, ctx) => {
  if ((session.phase === 'paused') !== (session.resume_phase !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['resume_phase'], message: 'resume_phase is required exactly while phase is paused' });
  }
  const awaitingCheck = session.phase === 'awaiting_check'
    || (session.phase === 'paused' && session.resume_phase === 'awaiting_check');
  if (awaitingCheck !== (session.pending_check !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pending_check'], message: 'pending_check must be present exactly while awaiting a check' });
  }
});
export type PersistedSessionV2 = z.infer<typeof PersistedSessionV2Schema>;

/** Global registry entry makes start_session retries idempotent before a session exists. */
export const StartRequestRecordSchema = z.object({
  request_id: RequestIdSchema,
  input_fingerprint: z.string().min(1).max(128),
  session_id: SessionIdSchema,
  result: PublicTurnSchema,
  created_at: z.string().datetime(),
}).strict();
export type StartRequestRecord = z.infer<typeof StartRequestRecordSchema>;

/** Private job ownership and restart metadata; PublicOperation omits these fields. */
export const StoredOperationSchema = z.object({
  operation_id: RequestIdSchema,
  kind: OperationKindSchema,
  owner_kind: z.enum(['session', 'conversation', 'request']),
  owner_id: z.string().uuid(),
  request_id: RequestIdSchema,
  input_fingerprint: z.string().min(1).max(128),
  status: OperationStatusSchema,
  created_at: z.string().datetime(),
  expires_at: z.string().datetime(),
  public_result: PublicOperationSchema.optional(),
}).strict().superRefine((operation, ctx) => {
  if (operation.status === 'pending' && operation.public_result) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['public_result'], message: 'pending operation cannot attach a terminal public result' });
  }
  if (operation.status !== 'pending' && !operation.public_result) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['public_result'], message: 'terminal operation requires a public result' });
  }
  if (operation.public_result && operation.public_result.operation_id !== operation.operation_id) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['public_result', 'operation_id'], message: 'public result must match operation_id' });
  }
  if (operation.public_result) {
    if (operation.public_result.status !== operation.status) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['public_result', 'status'], message: 'public result status must match stored status' });
    }
    if (operation.public_result.kind !== operation.kind) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['public_result', 'kind'], message: 'public result kind must match stored kind' });
    }
    const expectedResultKind = operation.kind === 'prepare_adventure' ? 'adventure' : 'image';
    if (operation.public_result.status === 'ready' && operation.public_result.result.kind !== expectedResultKind) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['public_result', 'result', 'kind'], message: 'ready result does not match operation kind' });
    }
  }
});
export type StoredOperation = z.infer<typeof StoredOperationSchema>;
