import { z } from 'zod';

export const AdventureIdSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).max(80);
export const ContentIdSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/).max(64);
export const AdventureLocaleSchema = z.enum(['en', 'es']);

export const AdventureConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('has_item'), item_id: ContentIdSchema }).strict(),
  z.object({ kind: z.literal('lacks_item'), item_id: ContentIdSchema }).strict(),
  z.object({
    kind: z.literal('variable'),
    variable_id: ContentIdSchema,
    operator: z.enum(['eq', 'ne', 'lt', 'lte', 'gt', 'gte']),
    value: z.number().finite(),
  }).strict(),
]);
export type AdventureCondition = z.infer<typeof AdventureConditionSchema>;

export const AdventureEffectSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('add_item'), item_id: ContentIdSchema }).strict(),
  z.object({ kind: z.literal('remove_item'), item_id: ContentIdSchema }).strict(),
  z.object({ kind: z.literal('set_variable'), variable_id: ContentIdSchema, value: z.number().finite() }).strict(),
  z.object({ kind: z.literal('increment_variable'), variable_id: ContentIdSchema, amount: z.number().finite() }).strict(),
]);
export type AdventureEffect = z.infer<typeof AdventureEffectSchema>;

const TransitionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('direct'), target_node_id: ContentIdSchema }).strict(),
  z.object({
    kind: z.literal('check'),
    sides: z.literal(20),
    difficulty_class: z.number().int().min(2).max(20),
    success_node_id: ContentIdSchema,
    setback_node_id: ContentIdSchema,
    success_effects: z.array(AdventureEffectSchema).default([]),
    setback_effects: z.array(AdventureEffectSchema).default([]),
  }).strict(),
]);

export const AdventureChoiceSchema = z.object({
  id: ContentIdSchema,
  label: z.string().trim().min(1).max(100),
  action: z.string().trim().min(1).max(240),
  conditions: z.array(AdventureConditionSchema).default([]),
  effects: z.array(AdventureEffectSchema).default([]),
  transition: TransitionSchema,
}).strict();

export const AffordanceTargetSchema = z.object({ id: ContentIdSchema, label: z.string().trim().min(1).max(80) }).strict();
export const AffordanceApproachSchema = z.object({ id: ContentIdSchema, label: z.string().trim().min(1).max(80) }).strict();
export const SceneAffordanceSchema = z.object({
  id: ContentIdSchema,
  /** The server-authorized graph choice that resolves this free action. */
  resolution_choice_id: ContentIdSchema,
  label: z.string().trim().min(1).max(100),
  summary: z.string().trim().min(1).max(240),
  targets: z.array(AffordanceTargetSchema).max(12).default([]),
  item_ids: z.array(ContentIdSchema).max(12).default([]),
  approaches: z.array(AffordanceApproachSchema).max(12).default([]),
}).strict();
export type SceneAffordance = z.infer<typeof SceneAffordanceSchema>;

const AdventureNodeSchema = z.discriminatedUnion('kind', [
  z.object({
    id: ContentIdSchema,
    kind: z.literal('scene'),
    title: z.string().trim().min(1).max(120),
    narration: z.string().trim().min(1).max(1600),
    secrets: z.array(z.string().trim().min(1).max(800)).default([]),
    affordances: z.array(SceneAffordanceSchema).max(16).default([]),
    choices: z.array(AdventureChoiceSchema).min(2).max(3),
  }).strict(),
  z.object({
    id: ContentIdSchema,
    kind: z.literal('ending'),
    title: z.string().trim().min(1).max(120),
    narration: z.string().trim().min(1).max(1600),
    secrets: z.array(z.string().trim().min(1).max(800)).default([]),
    affordances: z.tuple([]).default([]),
    choices: z.tuple([]),
  }).strict(),
]);
export type AdventureNode = z.infer<typeof AdventureNodeSchema>;

export const AdventureDefinitionSchema = z.object({
  schema_version: z.literal(1),
  id: AdventureIdSchema,
  version: z.number().int().positive(),
  title: z.string().trim().min(1).max(120),
  locale: AdventureLocaleSchema,
  genre: z.string().trim().min(1).max(60),
  tone: z.string().trim().min(1).max(120),
  duration_minutes: z.number().int().min(5).max(60),
  players: z.object({ min: z.number().int().min(1).max(6), max: z.number().int().min(1).max(6) }).strict(),
  content_limits: z.array(z.string().trim().min(1).max(100)).max(20),
  objective: z.string().trim().min(1).max(500),
  characters: z.array(z.object({
    id: ContentIdSchema,
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(400),
  }).strict()).max(30),
  items: z.array(z.object({
    id: ContentIdSchema,
    name: z.string().trim().min(1).max(80),
    description: z.string().trim().min(1).max(240),
  }).strict()).max(40),
  variables: z.record(ContentIdSchema, z.object({
    initial: z.number().finite(),
    min: z.number().finite(),
    max: z.number().finite(),
  }).strict()),
  initial_node_id: ContentIdSchema,
  nodes: z.array(AdventureNodeSchema).min(3).max(40),
}).strict().superRefine((adventure, ctx) => {
  if (adventure.players.min > adventure.players.max) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['players', 'min'], message: 'players.min must not exceed players.max' });
  }
  for (const [id, variable] of Object.entries(adventure.variables)) {
    if (variable.min > variable.max || variable.initial < variable.min || variable.initial > variable.max) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['variables', id], message: 'variable initial/min/max are inconsistent' });
    }
  }
});

export type AdventureDefinition = z.infer<typeof AdventureDefinitionSchema>;
export type AdventureChoice = z.infer<typeof AdventureChoiceSchema>;
