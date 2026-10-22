import { randomInt, randomUUID } from 'node:crypto';
import {
  type AdventureChoice,
  type AdventureCondition,
  type AdventureDefinition,
  type AdventureEffect,
  type AdventureNode,
} from '../../shared/adventure-schema.js';
import type { PlayerInteraction } from '../../shared/host-schema.js';
import {
  PersistedSessionV2Schema,
  PublicTurnSchema,
  type PersistedSessionV2,
  type PublicOutcome,
  type PublicTurn,
  type SessionEvent,
} from '../../shared/session-schema.js';
import { formatAdventureIssues, validateAdventureDefinition } from '../../shared/adventure-validation.js';

export class EngineError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly clarification = false,
  ) {
    super(message);
    this.name = 'EngineError';
  }
}

export type EngineDependencies = {
  now?: () => string;
  createId?: () => string;
  rollD20?: () => number;
};

function dependencies(input: EngineDependencies = {}): Required<EngineDependencies> {
  return {
    now: input.now ?? (() => new Date().toISOString()),
    createId: input.createId ?? randomUUID,
    rollD20: input.rollD20 ?? (() => randomInt(1, 21)),
  };
}

function validatedAdventure(input: unknown): AdventureDefinition {
  const validation = validateAdventureDefinition(input);
  if (!validation.ok) {
    throw new EngineError('INVALID_ADVENTURE', formatAdventureIssues(validation.issues));
  }
  return validation.adventure;
}

function nodeFor(adventure: AdventureDefinition, nodeId: string): AdventureNode {
  const node = adventure.nodes.find((item) => item.id === nodeId);
  if (!node) throw new EngineError('INVALID_STATE', 'Current node "' + nodeId + '" is missing from this adventure.');
  return node;
}

function conditionMatches(condition: AdventureCondition, session: PersistedSessionV2): boolean {
  if (condition.kind === 'has_item') return session.inventory.includes(condition.item_id);
  if (condition.kind === 'lacks_item') return !session.inventory.includes(condition.item_id);
  const actual = session.variables[condition.variable_id];
  if (actual === undefined) throw new EngineError('INVALID_STATE', 'Variable "' + condition.variable_id + '" is missing.');
  switch (condition.operator) {
    case 'eq': return actual === condition.value;
    case 'ne': return actual !== condition.value;
    case 'lt': return actual < condition.value;
    case 'lte': return actual <= condition.value;
    case 'gt': return actual > condition.value;
    case 'gte': return actual >= condition.value;
  }
}

function choiceEnabled(choice: AdventureChoice, session: PersistedSessionV2): boolean {
  return choice.conditions.every((condition) => conditionMatches(condition, session));
}

function applyEffects(
  adventure: AdventureDefinition,
  session: PersistedSessionV2,
  effects: AdventureEffect[],
): Pick<PersistedSessionV2, 'inventory' | 'variables'> {
  const inventory = [...session.inventory];
  const variables = { ...session.variables };
  for (const effect of effects) {
    if (effect.kind === 'add_item' || effect.kind === 'remove_item') {
      if (!adventure.items.some((item) => item.id === effect.item_id)) {
        throw new EngineError('INVALID_ADVENTURE', 'Effect references missing item "' + effect.item_id + '".');
      }
      const index = inventory.indexOf(effect.item_id);
      if (effect.kind === 'add_item' && index < 0) inventory.push(effect.item_id);
      if (effect.kind === 'remove_item' && index >= 0) inventory.splice(index, 1);
      continue;
    }
    const bounds = adventure.variables[effect.variable_id];
    const current = variables[effect.variable_id];
    if (!bounds || current === undefined) {
      throw new EngineError('INVALID_ADVENTURE', 'Effect references missing variable "' + effect.variable_id + '".');
    }
    const value = effect.kind === 'set_variable' ? effect.value : current + effect.amount;
    if (value < bounds.min || value > bounds.max) {
      throw new EngineError('EFFECT_OUT_OF_BOUNDS', 'The effect would move variable "' + effect.variable_id + '" outside its declared range.');
    }
    variables[effect.variable_id] = value;
  }
  return { inventory, variables };
}

function requireActiveScene(
  adventure: AdventureDefinition,
  session: PersistedSessionV2,
): Extract<AdventureNode, { kind: 'scene' }> {
  if (session.adventure_id !== adventure.id || session.adventure_version !== adventure.version
    || session.adventure_locale !== adventure.locale) {
    throw new EngineError('ADVENTURE_VERSION_MISMATCH', 'The session is bound to a different adventure version.');
  }
  if (session.phase !== 'awaiting_choice') {
    throw new EngineError('PHASE_CONFLICT', 'Actions are not accepted while the session is ' + session.phase + '.');
  }
  const node = nodeFor(adventure, session.current_node_id);
  if (node.kind !== 'scene') throw new EngineError('INVALID_STATE', 'A playable session points to an ending node.');
  return node;
}

type EventDetails = Partial<Pick<SessionEvent,
  'choice_id' | 'action_text' | 'affordance_id' | 'target_id' | 'item_id' | 'approach_id' | 'check_total' | 'outcome'>>;

function makeEvent(
  revision: number,
  requestId: string | null,
  kind: SessionEvent['kind'],
  nodeId: string,
  now: string,
  details: EventDetails = {},
): SessionEvent {
  return {
    revision, request_id: requestId, kind, node_id: nodeId,
    choice_id: details.choice_id ?? null,
    action_text: details.action_text ?? null,
    affordance_id: details.affordance_id ?? null,
    target_id: details.target_id ?? null,
    item_id: details.item_id ?? null,
    approach_id: details.approach_id ?? null,
    check_total: details.check_total ?? null,
    outcome: details.outcome ?? null,
    occurred_at: now,
  };
}

function appendRecap(recap: string, entry: string): string {
  return [recap, entry].filter(Boolean).slice(-4).join('\n').slice(-1200);
}

function assertSessionMatchesAdventure(adventure: AdventureDefinition, session: PersistedSessionV2): AdventureNode {
  if (session.adventure_id !== adventure.id || session.adventure_version !== adventure.version
    || session.adventure_locale !== adventure.locale) {
    throw new EngineError('ADVENTURE_VERSION_MISMATCH', 'The session is bound to a different adventure version.');
  }
  const node = nodeFor(adventure, session.current_node_id);
  if (session.event_log.length === 0 || session.event_log.at(-1)!.revision !== session.revision
    || session.event_log.at(-1)!.node_id !== session.current_node_id
    || session.event_log.some((event, index) => event.revision !== index + 1)) {
    throw new EngineError('INVALID_STATE', 'Session event history does not match its current revision and scene.');
  }
  const declaredVariables = Object.keys(adventure.variables).sort();
  const savedVariables = Object.keys(session.variables).sort();
  if (declaredVariables.length !== savedVariables.length || declaredVariables.some((id, index) => id !== savedVariables[index])) {
    throw new EngineError('INVALID_STATE', 'Session variables do not match the adventure definition.');
  }
  for (const [id, definition] of Object.entries(adventure.variables)) {
    const value = session.variables[id];
    if (value < definition.min || value > definition.max) {
      throw new EngineError('INVALID_STATE', 'Session variable "' + id + '" is outside its declared bounds.');
    }
  }
  if (new Set(session.inventory).size !== session.inventory.length
    || session.inventory.some((id) => !adventure.items.some((item) => item.id === id))) {
    throw new EngineError('INVALID_STATE', 'Session inventory contains a duplicate or unknown item.');
  }
  const lastEvent = session.event_log.at(-1);
  const isCheckPending = session.phase === 'awaiting_check'
    || (session.phase === 'paused' && session.resume_phase === 'awaiting_check');
  if (isCheckPending) {
    if (node.kind !== 'scene' || !session.pending_check) {
      throw new EngineError('INVALID_STATE', 'A pending check must belong to an active scene.');
    }
    const choice = node.choices.find((candidate) => candidate.id === session.pending_check!.choice_id);
    if (!choice || choice.transition.kind !== 'check') {
      throw new EngineError('INVALID_STATE', 'The pending check no longer references a valid scene choice.');
    }
  } else if (session.phase === 'awaiting_choice' || (session.phase === 'paused' && session.resume_phase === 'awaiting_choice') || session.phase === 'busy') {
    if (node.kind !== 'scene') throw new EngineError('INVALID_STATE', 'A playable session must point to a scene.');
  } else if (session.phase === 'ended') {
    if (node.kind === 'ending') {
      if (!lastEvent || !['ended', 'check'].includes(lastEvent.kind) || lastEvent.choice_id === null) {
        throw new EngineError('INVALID_STATE', 'A story ending must be backed by its committed ending choice.');
      }
    } else if (lastEvent?.kind !== 'ended' || lastEvent.choice_id !== null) {
      throw new EngineError('INVALID_STATE', 'A session closed before a story ending must have an explicit close event.');
    }
  }
  if (session.phase !== 'ended' && node.kind === 'ending') {
    throw new EngineError('INVALID_STATE', 'An active session cannot point to an ending node.');
  }
  return node;
}

function project(
  adventure: AdventureDefinition,
  session: PersistedSessionV2,
  phase = session.phase,
): PublicTurn {
  const node = assertSessionMatchesAdventure(adventure, session);
  const scene = node.kind === 'scene' ? node : null;
  const playable = phase === 'awaiting_choice' && scene !== null;
  const choices = playable
    ? scene.choices.filter((choice) => choiceEnabled(choice, session)).map(({ id, label }) => ({ id, label }))
    : [];
  const affordances = playable ? scene.affordances
    .filter((affordance) => {
      const choice = scene.choices.find((candidate) => candidate.id === affordance.resolution_choice_id);
      return choice !== undefined && choiceEnabled(choice, session);
    })
    .map((affordance) => ({
      ...affordance,
      item_ids: affordance.item_ids.filter((id) => session.inventory.includes(id)),
    })) : [];
  const inventory = session.inventory.map((id) => {
    const item = adventure.items.find((candidate) => candidate.id === id);
    if (!item) throw new EngineError('INVALID_STATE', 'Inventory references unknown item "' + id + '".');
    return item;
  });
  let pendingCheck: PublicTurn['pending_check'] = null;
  if (phase === 'awaiting_check' && session.pending_check && scene) {
    const choice = scene.choices.find((candidate) => candidate.id === session.pending_check!.choice_id);
    if (!choice || choice.transition.kind !== 'check') {
      throw new EngineError('INVALID_STATE', 'The pending check no longer references its action.');
    }
    pendingCheck = {
      id: session.pending_check.id,
      kind: 'd20',
      difficulty_class: choice.transition.difficulty_class,
      prompt: choice.action,
    };
  }
  const spanish = adventure.locale === 'es';
  return PublicTurnSchema.parse({
    schema_version: 2,
    session_id: session.session_id,
    locale: adventure.locale,
    revision: session.revision,
    view_revision: session.view_revision,
    phase,
    scene_id: node.id,
    narration: node.narration,
    choices,
    affordances,
    pending_check: pendingCheck,
    recent_outcome: session.recent_outcome,
    inventory,
    recap: session.recap,
    next_expected_input: phase === 'ended' ? '' : spanish
      ? choices.length === 0 ? 'Cuéntame qué quieres hacer.' : 'Elige una opción o cuenta qué quieres hacer.'
      : choices.length === 0 ? 'Tell me what you want to do.' : 'Choose an option or say what you want to do.',
    visual_status: 'ready',
  });
}

export function createInitialSession(
  adventureInput: unknown,
  input: { sessionId: string; requestId: string; players: string[] },
  depsInput: EngineDependencies = {},
): { adventure: AdventureDefinition; session: PersistedSessionV2; turn: PublicTurn } {
  const adventure = validatedAdventure(adventureInput);
  const deps = dependencies(depsInput);
  if (input.players.length < adventure.players.min || input.players.length > adventure.players.max) {
    throw new EngineError('PLAYER_COUNT_INVALID', 'This adventure allows ' + adventure.players.min + '–' + adventure.players.max + ' players.');
  }
  const now = deps.now();
  const session = PersistedSessionV2Schema.parse({
    schema_version: 2,
    session_id: input.sessionId,
    revision: 1,
    view_revision: 1,
    adventure_id: adventure.id,
    adventure_version: adventure.version,
    adventure_locale: adventure.locale,
    players: input.players,
    phase: 'awaiting_choice',
    resume_phase: null,
    pending_check: null,
    recent_outcome: null,
    recap: '',
    current_node_id: adventure.initial_node_id,
    variables: Object.fromEntries(Object.entries(adventure.variables).map(([id, variable]) => [id, variable.initial])),
    inventory: [],
    event_log: [makeEvent(1, input.requestId, 'started', adventure.initial_node_id, now)],
    idempotency_records: [],
    updated_at: now,
  });
  return { adventure, session, turn: project(adventure, session) };
}

export function submitInteraction(
  adventureInput: unknown,
  sessionInput: PersistedSessionV2,
  interaction: PlayerInteraction,
  input: { requestId: string; originalText?: string },
  depsInput: EngineDependencies = {},
): { session: PersistedSessionV2; turn: PublicTurn } {
  const adventure = validatedAdventure(adventureInput);
  const session = PersistedSessionV2Schema.parse(sessionInput);
  const deps = dependencies(depsInput);
  assertSessionMatchesAdventure(adventure, session);
  const node = requireActiveScene(adventure, session);
  let choice: AdventureChoice;
  let freeActionDetails: EventDetails = {};

  if (interaction.kind === 'choice') {
    const found = node.choices.find((candidate) => candidate.id === interaction.choice_id);
    if (!found) throw new EngineError('CHOICE_NOT_FOUND', 'That option is not available in the current scene.');
    choice = found;
  } else {
    const affordance = node.affordances.find((candidate) => candidate.id === interaction.affordance_id);
    if (!affordance) throw new EngineError('ACTION_NOT_ALLOWED', 'That action is not available in the current scene.');
    const selectedTarget = interaction.target_id
      ?? (affordance.targets.length === 1 ? affordance.targets[0]!.id : undefined);
    if (affordance.targets.length > 0 && !selectedTarget) {
      throw new EngineError('CLARIFICATION_REQUIRED', 'Which ' + affordance.targets.map((target) => target.label).join(' or ') + ' do you mean?', true);
    }
    if (selectedTarget && !affordance.targets.some((target) => target.id === selectedTarget)) {
      throw new EngineError('ACTION_NOT_ALLOWED', 'That target is not available for this action.');
    }
    if (interaction.item_id && !affordance.item_ids.includes(interaction.item_id)) {
      throw new EngineError('ITEM_NOT_ALLOWED', 'That item cannot be used for this action.');
    }
    if (interaction.item_id && !session.inventory.includes(interaction.item_id)) {
      throw new EngineError('ITEM_NOT_OWNED', 'The group does not have that item.');
    }
    const selectedApproach = interaction.approach_id
      ?? (affordance.approaches.length === 1 ? affordance.approaches[0]!.id : undefined);
    if (affordance.approaches.length > 0 && !selectedApproach) {
      throw new EngineError('CLARIFICATION_REQUIRED', 'Which approach do you mean: ' + affordance.approaches.map((approach) => approach.label).join(' or ') + '?', true);
    }
    if (selectedApproach && !affordance.approaches.some((approach) => approach.id === selectedApproach)) {
      throw new EngineError('ACTION_NOT_ALLOWED', 'That approach is not available for this action.');
    }
    freeActionDetails = {
      affordance_id: affordance.id,
      target_id: selectedTarget ?? null,
      item_id: interaction.item_id ?? null,
      approach_id: selectedApproach ?? null,
    };
    const found = node.choices.find((candidate) => candidate.id === affordance.resolution_choice_id);
    if (!found) throw new EngineError('INVALID_ADVENTURE', 'An affordance references a missing resolution choice.');
    choice = found;
  }

  if (!choiceEnabled(choice, session)) {
    throw new EngineError('CHOICE_UNAVAILABLE', 'That option is not available with the group’s current items or progress.');
  }
  const nextRevision = session.revision + 1;
  const now = deps.now();
  const actionText = input.originalText?.trim() || interaction.action_text;
  if (actionText.length > 1200) {
    throw new EngineError('ACTION_TEXT_TOO_LONG', 'Player action text must be at most 1200 characters.');
  }
  const applied = applyEffects(adventure, session, choice.effects);
  let next: PersistedSessionV2;
  let nextPhase: 'awaiting_choice' | 'awaiting_check' | 'ended';
  let outcome: PublicOutcome | null;

  if (choice.transition.kind === 'check') {
    nextPhase = 'awaiting_check';
    outcome = null;
    const checkId = 'check-' + deps.createId();
    next = PersistedSessionV2Schema.parse({
      ...session,
      ...applied,
      phase: 'awaiting_check',
      pending_check: { id: checkId, choice_id: choice.id, created_at: now },
      recent_outcome: null,
      revision: nextRevision,
      view_revision: session.view_revision + 1,
      event_log: [...session.event_log, makeEvent(nextRevision, input.requestId, 'action', node.id, now, { choice_id: choice.id, action_text: actionText, ...freeActionDetails })],
      updated_at: now,
    });
  } else {
    const target = nodeFor(adventure, choice.transition.target_node_id);
    nextPhase = target.kind === 'ending' ? 'ended' : 'awaiting_choice';
    outcome = target.kind === 'ending'
      ? { kind: 'ending', ending_id: target.id, summary: target.narration }
      : { kind: 'action', action_label: choice.label, summary: target.narration };
    next = PersistedSessionV2Schema.parse({
      ...session,
      ...applied,
      current_node_id: target.id,
      phase: nextPhase,
      resume_phase: null,
      pending_check: null,
      recent_outcome: outcome,
      recap: appendRecap(session.recap, choice.label + ': ' + target.title),
      revision: nextRevision,
      view_revision: session.view_revision + 1,
      event_log: [...session.event_log, makeEvent(nextRevision, input.requestId, target.kind === 'ending' ? 'ended' : 'action', target.id, now, { choice_id: choice.id, action_text: actionText, ...freeActionDetails })],
      updated_at: now,
    });
  }
  return { session: next, turn: project(adventure, next, nextPhase) };
}

export function resolvePendingCheck(
  adventureInput: unknown,
  sessionInput: PersistedSessionV2,
  input: { checkId: string; requestId: string },
  depsInput: EngineDependencies = {},
): { session: PersistedSessionV2; turn: PublicTurn } {
  const adventure = validatedAdventure(adventureInput);
  const session = PersistedSessionV2Schema.parse(sessionInput);
  const deps = dependencies(depsInput);
  assertSessionMatchesAdventure(adventure, session);
  if (session.phase !== 'awaiting_check' || !session.pending_check) {
    throw new EngineError('CHECK_NOT_PENDING', 'There is no check waiting to be resolved.');
  }
  if (session.pending_check.id !== input.checkId) {
    throw new EngineError('CHECK_ID_MISMATCH', 'That check is no longer pending.');
  }
  const source = nodeFor(adventure, session.current_node_id);
  if (source.kind !== 'scene') throw new EngineError('INVALID_STATE', 'A pending check must belong to a scene.');
  const choice = source.choices.find((candidate) => candidate.id === session.pending_check!.choice_id);
  if (!choice || choice.transition.kind !== 'check') {
    throw new EngineError('INVALID_STATE', 'The pending check no longer references a valid transition.');
  }
  const total = deps.rollD20();
  if (!Number.isInteger(total) || total < 1 || total > 20) {
    throw new EngineError('INVALID_ROLL', 'The server roll must be an integer from 1 to 20.');
  }
  const success = total >= choice.transition.difficulty_class;
  const effects = success ? choice.transition.success_effects : choice.transition.setback_effects;
  const applied = applyEffects(adventure, session, effects);
  const targetId = success ? choice.transition.success_node_id : choice.transition.setback_node_id;
  const target = nodeFor(adventure, targetId);
  const phase = target.kind === 'ending' ? 'ended' : 'awaiting_choice';
  const result = success ? 'success' : 'setback';
  const outcome: PublicOutcome = {
    kind: 'check',
    check_id: input.checkId,
    sides: 20,
    total,
    difficulty_class: choice.transition.difficulty_class,
    result,
    summary: target.narration,
  };
  const nextRevision = session.revision + 1;
  const now = deps.now();
  const next = PersistedSessionV2Schema.parse({
    ...session,
    ...applied,
    current_node_id: target.id,
    phase,
    resume_phase: null,
    pending_check: null,
    recent_outcome: outcome,
    recap: appendRecap(session.recap, choice.label + ': ' + result + ' (' + total + '/20). ' + target.title),
    revision: nextRevision,
    view_revision: session.view_revision + 1,
    event_log: [...session.event_log, makeEvent(nextRevision, input.requestId, 'check', target.id, now, {
      choice_id: choice.id,
      check_total: total,
      outcome: result,
    })],
    updated_at: now,
  });
  return { session: next, turn: project(adventure, next, phase) };
}

/** Explicit player closure keeps the current scene; it does not invent an authored story ending. */
export function endSession(
  adventureInput: unknown,
  sessionInput: PersistedSessionV2,
  input: { requestId: string },
  depsInput: EngineDependencies = {},
): { session: PersistedSessionV2; turn: PublicTurn } {
  const adventure = validatedAdventure(adventureInput);
  const session = PersistedSessionV2Schema.parse(sessionInput);
  const deps = dependencies(depsInput);
  const node = assertSessionMatchesAdventure(adventure, session);
  if (session.phase === 'ended') throw new EngineError('ALREADY_ENDED', 'This session has already ended.');
  if (session.phase === 'busy') throw new EngineError('PHASE_CONFLICT', 'Wait for the pending operation before ending the session.');
  if (node.kind !== 'scene') throw new EngineError('INVALID_STATE', 'An active session must point to a scene.');

  const now = deps.now();
  const revision = session.revision + 1;
  const next = PersistedSessionV2Schema.parse({
    ...session,
    phase: 'ended',
    resume_phase: null,
    pending_check: null,
    recent_outcome: null,
    recap: appendRecap(session.recap, adventure.locale === 'es'
      ? 'El grupo cerró la partida en esta escena.'
      : 'The group closed the session in this scene.'),
    revision,
    view_revision: session.view_revision + 1,
    event_log: [...session.event_log, makeEvent(revision, input.requestId, 'ended', node.id, now)],
    updated_at: now,
  });
  return { session: next, turn: project(adventure, next) };
}

export function getPublicTurn(adventureInput: unknown, sessionInput: PersistedSessionV2): PublicTurn {
  const adventure = validatedAdventure(adventureInput);
  const session = PersistedSessionV2Schema.parse(sessionInput);
  assertSessionMatchesAdventure(adventure, session);
  return project(adventure, session);
}
