import { z } from 'zod';
import { AdventureIdSchema, AdventureLocaleSchema, ContentIdSchema } from './adventure-schema.js';
import {
  PublicErrorSchema, PublicOperationSchema, PublicTurnSchema, RequestIdSchema, RevisionSchema,
  SessionIdSchema,
} from './session-schema.js';

export const ConversationIdSchema = z.string().uuid();
export const PlayerNameSchema = z.string().trim().min(1).max(32);

/** Read-only snapshot for the shared host display; it contains only canonical public turns. */
export const HostPublicStateSchema = z.object({
  conversation_id: ConversationIdSchema,
  locale: AdventureLocaleSchema,
  session_id: SessionIdSchema.nullable(),
  paused: z.boolean(),
  turn: z.union([PublicTurnSchema, z.null()]),
  turns: z.array(PublicTurnSchema).max(40),
}).strict().superRefine((state, ctx) => {
  if ((state.session_id === null) !== (state.turn === null)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['turn'], message: 'session_id and turn must be present together' });
  if (state.turn && (state.turn.session_id !== state.session_id || state.turn.locale !== state.locale)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['turn'], message: 'current turn must match the public session' });
  if (state.turns.some((turn) => turn.session_id !== state.session_id || turn.locale !== state.locale)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['turns'], message: 'public history must belong to the current session and locale' });
  if (state.turn && state.turns.length && state.turns.at(-1)?.revision !== state.turn.revision) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['turns'], message: 'the final public history turn must match the current revision' });
});
export type HostPublicState = z.infer<typeof HostPublicStateSchema>;

export const CreateConversationRequestSchema = z.object({
  request_id: RequestIdSchema,
  locale: AdventureLocaleSchema.default('en'),
  session_id: SessionIdSchema.optional(),
}).strict();
export type CreateConversationRequest = z.infer<typeof CreateConversationRequestSchema>;

export const PlayerTurnRequestSchema = z.object({
  request_id: RequestIdSchema,
  text: z.string().trim().min(1).max(1200),
  expected_revision: RevisionSchema.optional(),
}).strict();
export type PlayerTurnRequest = z.infer<typeof PlayerTurnRequestSchema>;

export const SessionControlRequestSchema = z.object({
  request_id: RequestIdSchema,
  expected_revision: RevisionSchema.optional(),
}).strict();
export type SessionControlRequest = z.infer<typeof SessionControlRequestSchema>;

export const HostConversationSchema = z.object({
  conversation_id: ConversationIdSchema,
  locale: AdventureLocaleSchema,
  session_id: z.union([SessionIdSchema, z.null()]),
  paused: z.boolean().default(false),
  created_at: z.string().datetime(),
}).strict();

export const HostResponseSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('message'),
    conversation: HostConversationSchema,
    assistant_text: z.string().min(1).max(2000),
  }).strict(),
  z.object({
    kind: z.literal('turn'),
    conversation: HostConversationSchema,
    turn: PublicTurnSchema,
    assistant_text: z.string().min(1).max(2000),
  }).strict(),
  z.object({
    kind: z.literal('clarification'),
    conversation: HostConversationSchema,
    turn: PublicTurnSchema,
    question: z.string().min(1).max(500),
  }).strict(),
  z.object({
    kind: z.literal('operation'),
    conversation: HostConversationSchema,
    operation: PublicOperationSchema,
  }).strict(),
  PublicErrorSchema,
]);
export type HostResponse = z.infer<typeof HostResponseSchema>;

/** Typed action payload; IDs must match the current public choices/affordances. */
export const PlayerInteractionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('choice'), choice_id: ContentIdSchema, action_text: z.string().trim().min(1).max(600) }).strict(),
  z.object({
    kind: z.literal('free_action'),
    affordance_id: ContentIdSchema,
    target_id: ContentIdSchema.optional(),
    item_id: ContentIdSchema.optional(),
    approach_id: ContentIdSchema.optional(),
    action_text: z.string().trim().min(1).max(600),
  }).strict(),
]);
export type PlayerInteraction = z.infer<typeof PlayerInteractionSchema>;

/** Typed LLM proposal; it carries intent but cannot apply effects or choose a destination. */
export const InteractionProposalSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('choice'), choice_id: ContentIdSchema, action_text: z.string().trim().min(1).max(600) }).strict(),
  z.object({
    kind: z.literal('free_action'),
    affordance_id: ContentIdSchema,
    target_id: ContentIdSchema.optional(),
    item_id: ContentIdSchema.optional(),
    approach_id: ContentIdSchema.optional(),
    action_text: z.string().trim().min(1).max(600),
  }).strict(),
  z.object({ kind: z.literal('clarification'), question: z.string().trim().min(1).max(500) }).strict(),
]);
export type InteractionProposal = z.infer<typeof InteractionProposalSchema>;

export const AdventureSummarySchema = z.object({
  id: AdventureIdSchema,
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(120),
  locale: AdventureLocaleSchema,
  genre: z.string().trim().min(1).max(60),
  tone: z.string().trim().min(1).max(120),
  duration_minutes: z.number().int().min(5).max(60),
  players: z.object({ min: z.number().int().min(1).max(6), max: z.number().int().min(1).max(6) }).strict(),
  objective: z.string().trim().min(1).max(240),
}).strict();
export type AdventureSummary = z.infer<typeof AdventureSummarySchema>;
export const ListAdventuresResponseSchema = z.object({ adventures: z.array(AdventureSummarySchema).max(200) }).strict();
export type ListAdventuresResponse = z.infer<typeof ListAdventuresResponseSchema>;

export const ListAdventuresRequestSchema = z.object({
  locale: AdventureLocaleSchema.optional(),
  genre: z.string().trim().min(1).max(60).optional(),
  players: z.number().int().min(1).max(6).optional(),
  duration_minutes: z.number().int().min(5).max(60).optional(),
}).strict();
export const PrepareAdventureRequestSchema = z.object({
  request_id: RequestIdSchema,
  premise: z.string().trim().min(1).max(1200),
  locale: AdventureLocaleSchema,
  preferences: z.object({
    genre: z.string().trim().min(1).max(60).optional(),
    tone: z.string().trim().min(1).max(120).optional(),
    duration_minutes: z.number().int().min(5).max(60).optional(),
    player_count: z.number().int().min(1).max(6).optional(),
    content_limits: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  }).strict(),
}).strict();
export const StartSessionRequestSchema = z.object({
  request_id: RequestIdSchema,
  adventure_id: AdventureIdSchema,
  locale: AdventureLocaleSchema.default('en'),
  players: z.array(PlayerNameSchema).min(1).max(6),
}).strict();
export const GetSessionRequestSchema = z.object({ session_id: SessionIdSchema }).strict();
export const SubmitActionRequestSchema = z.object({
  session_id: SessionIdSchema,
  expected_revision: RevisionSchema,
  request_id: RequestIdSchema,
  interaction: PlayerInteractionSchema,
}).strict();
export const ResolveCheckRequestSchema = z.object({
  session_id: SessionIdSchema,
  expected_revision: RevisionSchema,
  request_id: RequestIdSchema,
  check_id: ContentIdSchema,
}).strict();
export const EndSessionRequestSchema = z.object({
  session_id: SessionIdSchema,
  expected_revision: RevisionSchema,
  request_id: RequestIdSchema,
}).strict();
export const GetOperationStatusRequestSchema = z.object({ operation_id: RequestIdSchema }).strict();
export const CancelOperationRequestSchema = z.object({
  operation_id: RequestIdSchema,
  request_id: RequestIdSchema,
}).strict();

export const MutationResponseSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('turn'), turn: PublicTurnSchema }).strict(),
  z.object({ kind: z.literal('operation'), operation: PublicOperationSchema }).strict(),
  PublicErrorSchema,
]);

export type ListAdventuresRequest = z.infer<typeof ListAdventuresRequestSchema>;
export type PrepareAdventureRequest = z.infer<typeof PrepareAdventureRequestSchema>;
export type StartSessionRequest = z.infer<typeof StartSessionRequestSchema>;
export type SubmitActionRequest = z.infer<typeof SubmitActionRequestSchema>;
export type ResolveCheckRequest = z.infer<typeof ResolveCheckRequestSchema>;
export type EndSessionRequest = z.infer<typeof EndSessionRequestSchema>;
export type CancelOperationRequest = z.infer<typeof CancelOperationRequestSchema>;
