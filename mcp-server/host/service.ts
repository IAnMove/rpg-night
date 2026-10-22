import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  CreateConversationRequestSchema, HostConversationSchema, HostPublicStateSchema, HostResponseSchema,
  ListAdventuresRequestSchema, ListAdventuresResponseSchema, PlayerInteractionSchema,
  PlayerTurnRequestSchema, PrepareAdventureRequestSchema, ResolveCheckRequestSchema, SessionControlRequestSchema,
  StartSessionRequestSchema, SubmitActionRequestSchema, EndSessionRequestSchema,
  type AdventureSummary, type HostPublicState, type HostResponse, type PlayerInteraction,
} from '../../shared/host-schema.js';
import { PublicErrorSchema, PublicOperationSchema, PublicTurnSchema, type PublicError, type PublicTurn } from '../../shared/session-schema.js';
import { ConversationStoreError, hostFingerprint, JsonConversationStore, type PersistedConversation } from './conversation-store.js';
import { MCP_TOOL_ALLOWLIST, McpGateway, McpGatewayError } from './mcp-gateway.js';
import { OllamaClient, OllamaError, OllamaMessage, OllamaTool } from '../llm/ollama.js';

export const HOST_MAX_MODEL_ROUNDS = 4;
export const HOST_MAX_TOOL_CALLS = 6;
export const HOST_TURN_TIMEOUT_MS = 90_000;
const MAX_HISTORY = 16;
const USER_ACTION_TEXT_LIMIT = 600;
const CLARIFICATION_TOOL: OllamaTool = {
  type: 'function',
  function: {
    name: 'ask_clarification',
    description: 'Ask the players a short question when their intent or a required target is ambiguous. This does not change the game.',
    parameters: {
      type: 'object', properties: { question: { type: 'string', minLength: 1, maxLength: 500 } },
      required: ['question'], additionalProperties: false,
    },
  },
};
const OllamaClarificationSchema = z.object({ question: z.string().trim().min(1).max(500) }).strict();
const CLOSE_INTENT = /\b(?:please\s+)?(?:end|finish|stop|quit|close|terminate)\s+(?:(?:the|this|our)\s+)?(?:session|adventure|game|campaign|playing)\b|\b(?:i want to|let's|lets|we should|can we|could we|please)\s+(?:end|finish|stop|quit|close|terminate)\s+(?:(?:the|this|our)\s+)?(?:session|adventure|game|campaign|playing)\b|\b(?:termina|terminemos|terminar|finaliza|finalicemos|finalizar|acabemos|acabar|paremos|parar|cerremos|cerrar)\s+(?:(?:la|el|esta|nuestra)\s+)?(?:partida|aventura|sesión|sesion|juego)\b|\b(?:quiero|vamos\s+a|podemos)\s+(?:terminar|finalizar|acabar|parar|cerrar)\s+(?:(?:la|el|esta|nuestra)\s+)?(?:partida|aventura|sesión|sesion|juego)\b/i;
const NEGATED_CLOSE_INTENT = /\b(?:don't|do not|never|not)\s+(?:(?:want|wish)\s+to\s+)?(?:end|finish|stop|quit|close|terminate)\s+(?:(?:the|this|our)\s+)?(?:session|adventure|game|campaign|playing)\b|\b(?:i\s+)?(?:don't|do not)\s+want\s+to\s+(?:end|finish|stop|quit|close|terminate)\s+(?:(?:the|this|our)\s+)?(?:session|adventure|game|campaign|playing)\b|\bno\s+(?:quiero\s+|vamos\s+a\s+)?(?:terminar|finalizar|acabar|parar|cerrar)\s+(?:(?:la|el|esta|nuestra)\s+)?(?:partida|aventura|sesión|sesion|juego)\b/i;
const AFFIRMATION = /\b(yes|yeah|yep|sure|okay|ok|go ahead|that one|the one|start it|empecemos|empieza|sí|si|vale|de acuerdo|esa|ese|esa misma)\b/i;

function publicError(code: PublicError['code'], message: string, retryable = false, currentRevision?: number): PublicError {
  return PublicErrorSchema.parse({ kind: 'error', code, message, retryable, ...(currentRevision === undefined ? {} : { current_revision: currentRevision }) });
}

export function redactSecrets(text: string): string {
  return text
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[redacted secret]')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [redacted]')
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])-[-A-Za-z0-9_]{12,}\b/g, '[redacted secret]')
    .replace(/\b(password|passwd|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*[^\s,;]+/gi, '$1=[redacted]')
    .replace(/https?:\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/gi, '[redacted credential URL]')
    .slice(0, 2000);
}

function responseConversation(record: PersistedConversation) {
  return HostConversationSchema.parse({
    conversation_id: record.conversation.conversation_id,
    locale: record.conversation.locale,
    session_id: record.session_id,
    paused: record.paused,
    created_at: record.conversation.created_at,
  });
}

function responseError(error: PublicError): HostResponse { return HostResponseSchema.parse(error); }

function asTurnResult(result: Record<string, unknown>): PublicTurn | PublicError {
  const structured = result.structuredContent;
  if (result.isError) {
    const safeError = PublicErrorSchema.safeParse((structured as { error?: unknown } | undefined)?.error ?? structured);
    return safeError.success ? safeError.data : publicError('INTERNAL_ERROR', 'The game service could not complete the request.', true);
  }
  const parsed = PublicTurnSchema.safeParse(structured);
  return parsed.success ? parsed.data : publicError('INTERNAL_ERROR', 'The game service returned an invalid public turn.');
}

function toolPayload(result: Record<string, unknown>): unknown {
  if (result.isError) {
    const structured = result.structuredContent as { error?: unknown } | undefined;
    const error = PublicErrorSchema.safeParse(structured?.error);
    if (error.success) return { kind: 'error', code: error.data.code, message: error.data.message, retryable: error.data.retryable };
    return { kind: 'error', code: 'INTERNAL_ERROR', message: 'The game service rejected the request.', retryable: true };
  }
  return result.structuredContent ?? { kind: 'error', code: 'INTERNAL_ERROR', message: 'The game service returned no structured result.', retryable: true };
}

function phraseIncluded(name: string, text: string): boolean {
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return escaped.length > 0 && new RegExp(`(?:^|[^\\p{L}\\p{N}])${escaped}(?:$|[^\\p{L}\\p{N}])`, 'iu').test(text);
}
function phraseNegated(name: string, text: string): boolean {
  const escaped = name.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:\\b(?:not|no|don't|do not|never)\\s+(?:to\\s+)?)(?:[\\p{L}\\p{N} ]{0,50})${escaped}`, 'iu').test(text);
}
export function hasExplicitCloseIntent(text: string): boolean { return CLOSE_INTENT.test(text) && !NEGATED_CLOSE_INTENT.test(text); }
function explicitDisagreementQuestion(turn: PublicTurn, text: string, locale: 'en' | 'es'): string | undefined {
  if (turn.phase !== 'awaiting_choice' || turn.choices.length < 2) return undefined;
  const disagreement = locale === 'en'
    ? /\b(?:we(?:'re| are) split|the group is split|we have not chosen|we haven't chosen|we have not decided|we haven't decided)\b/i
    : /\b(?:no nos ponemos de acuerdo|estamos divididos|aún no hemos elegido|aun no hemos elegido|todavía no hemos elegido|todavia no hemos elegido|no hemos decidido)\b/i;
  const explicitRequest = locale === 'en'
    ? /\b(?:ask us|ask the players|which action did we mean|so we can decide)\b/i
    : /\b(?:haznos una pregunta|pregúntanos|preguntanos|cuál queríamos decir|cual queriamos decir|para que decidamos)\b/i;
  if (!disagreement.test(text) || !explicitRequest.test(text)) return undefined;
  const choices = turn.choices.map(choice => choice.label);
  const alternatives = choices.length === 2
    ? `${choices[0]} ${locale === 'en' ? 'or' : 'o'} ${choices[1]}`
    : `${choices.slice(0, -1).join(', ')} ${locale === 'en' ? 'or' : 'o'} ${choices.at(-1)}`;
  return locale === 'en'
    ? `Which would you like to do first: ${alternatives}?`
    : `¿Cuál queréis hacer primero: ${alternatives}?`;
}
function isExplicitNewAdventureRequest(text: string, locale: 'en' | 'es'): boolean {
  const refusal = locale === 'en'
    ? /\b(?:don't|do not|never|not)\b.{0,50}\b(?:create|make|write|generate|prepare)\b/i
    : /\bno\b.{0,50}\b(?:crees|crea|prepares|prepara|generes|genera|escribas|escribe|inventes|inventa)\b/i;
  if (refusal.test(text)) return false;
  const action = locale === 'en' ? /\b(?:create|make|write|generate|prepare)\b/i : /\b(?:crea|crees|prepara|prepares|genera|generes|escribe|escribas|inventa|inventes)\b/i;
  const story = locale === 'en' ? /\b(?:new|fresh|story|adventure|mystery|premise)\b/i : /\b(?:nueva?|historia|aventura|misterio|premisa)\b/i;
  const actionIndex = text.search(action);
  const storyIndex = text.search(story);
  return actionIndex >= 0 && storyIndex > actionIndex && storyIndex - actionIndex <= 100;
}
function explicitOrdinal(text: string): number | undefined {
  const match = text.match(/\b(?:option|number|choice)\s*(\d+)\b|\b(?:first|1st|second|2nd|third|3rd|fourth|4th)\b|\b(?:opción|opcion|número|numero)\s*(\d+)\b|\b(?:primera|primero|segunda|segundo|tercera|tercero|cuarta|cuarto)\b/i);
  if (!match) return undefined;
  const numeric = Number(match[1] ?? match[2]);
  if (Number.isInteger(numeric) && numeric > 0) return numeric;
  const words = /\b(first|1st|primera|primero)\b/i;
  if (words.test(match[0])) return 1;
  if (/\b(second|2nd|segunda|segundo)\b/i.test(match[0])) return 2;
  if (/\b(third|3rd|tercera|tercero)\b/i.test(match[0])) return 3;
  if (/\b(fourth|4th|cuarta|cuarto)\b/i.test(match[0])) return 4;
  return undefined;
}
const DIRECT_CHOICE_INTENT = /\b(?:i|we)\s+(?:explicitly\s+)?(?:choose|select|pick|take)\b|\b(?:let's|lets)\s+take\b|\bgo\s+with\b|\b(?:elijo|elegimos|escojo|escogemos|selecciono|seleccionamos|tomamos)(?:\s+explícitamente)?\b|\b(?:vamos\s+con|me\s+quedo\s+con|nos\s+quedamos\s+con)\b|\b(?:choose|select|pick|take|elige|elegid|elijan|selecciona|seleccionad|escojamos|elijamos)\s+(?:option|choice|opción|opcion)\b/i;
const NEGATED_CHOICE_INTENT = /\b(?:don't|do not|never|can't|cannot|shouldn't|should not|not)\b.{0,80}\b(?:choose|select|pick|take)\b|\bno\s+(?:elijas|elijamos|eligen|elegimos|elegir|selecciones|seleccionemos|seleccionan|seleccionamos|escojas|escojamos|escogemos)\b/i;
const QUESTION_INTENT = /[?¿]|^\s*(?:should|could|would|can|may|do|deberíamos|podemos|podría|conviene)\b/i;
/** Resolve only an unambiguous affirmative ordinal choice; free-form intent remains with the host model. */
export function resolveExplicitPlayerChoice(turn: PublicTurn, text: string) {
  if (turn.phase !== 'awaiting_choice' || QUESTION_INTENT.test(text) || NEGATED_CHOICE_INTENT.test(text) || !DIRECT_CHOICE_INTENT.test(text)) return undefined;
  const ordinal = explicitOrdinal(text);
  if (ordinal === undefined || ordinal > turn.choices.length) return undefined;
  return turn.choices[ordinal - 1];
}

const DIRECT_CHECK_INTENT = /\b(?:resolve|roll|make)\s+(?:the\s+)?(?:pending\s+)?(?:d20\s+)?check\b|\b(?:resuelve|resolvamos|tiramos|tira|haz|hagamos)\s+(?:(?:ahora|ya)\s+)?(?:la\s+)?(?:tirada|comprobación|comprobacion)\b/i;
export function hasExplicitCheckIntent(turn: PublicTurn, text: string): boolean {
  return turn.phase === 'awaiting_check' && turn.pending_check !== null && !QUESTION_INTENT.test(text)
    && !/\b(?:don't|do not|never|can't|cannot|not)\b.{0,80}\b(?:resolve|roll|make)\b|\bno\s+(?:resuelvas|resolvamos|tires|hagamos)\b/i.test(text)
    && DIRECT_CHECK_INTENT.test(text);
}
export function resolvePlayerAdventureSelection(offeredAdventureIds: string[], text: string, catalogue: AdventureSummary[]): AdventureSummary | undefined {
  const offered = catalogue.filter((candidate) => offeredAdventureIds.includes(candidate.id));
  const explicit = offered.filter((adventure) =>
    (phraseIncluded(adventure.title, text) || phraseIncluded(adventure.id, text))
    && !phraseNegated(adventure.title, text) && !phraseNegated(adventure.id, text));
  if (explicit.length === 1) return explicit[0];
  if (explicit.length > 1) return undefined;
  const ordinal = explicitOrdinal(text);
  if (ordinal !== undefined) return offered[ordinal - 1];
  return offered.length === 1 && AFFIRMATION.test(text) ? offered[0] : undefined;
}
export function playerSelectedAdventure(adventure: AdventureSummary, offeredAdventureIds: string[], text: string, catalogue: AdventureSummary[]): boolean {
  return resolvePlayerAdventureSelection(offeredAdventureIds, text, catalogue)?.id === adventure.id;
}

function isError(value: unknown): value is PublicError { return PublicErrorSchema.safeParse(value).success; }

export function validateInteractionAgainstTurn(turn: PublicTurn, input: unknown, userText: string): { ok: true; interaction: PlayerInteraction } | { ok: false; error: PublicError } {
  if (turn.phase !== 'awaiting_choice') return { ok: false, error: publicError('INVALID_INPUT', 'The current turn is not accepting an action.') };
  const parsed = PlayerInteractionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: publicError('INVALID_INPUT', 'The action did not match the public choice or affordance contract.') };
  const proposal = parsed.data;
  if (proposal.kind === 'choice') {
    if (!turn.choices.some((choice) => choice.id === proposal.choice_id)) return { ok: false, error: publicError('INVALID_INPUT', 'That choice is not present in the current public turn.') };
  } else {
    const affordance = turn.affordances.find((candidate) => candidate.id === proposal.affordance_id);
    if (!affordance) return { ok: false, error: publicError('INVALID_INPUT', 'That affordance is not present in the current public turn.') };
    if (proposal.target_id && !affordance.targets.some((target) => target.id === proposal.target_id)) return { ok: false, error: publicError('INVALID_INPUT', 'That target is not authorized by the public affordance.') };
    if (proposal.item_id && (!affordance.item_ids.includes(proposal.item_id) || !turn.inventory.some((item) => item.id === proposal.item_id))) return { ok: false, error: publicError('INVALID_INPUT', 'That item is not available for this public affordance.') };
    if (proposal.approach_id && !affordance.approaches.some((approach) => approach.id === proposal.approach_id)) return { ok: false, error: publicError('INVALID_INPUT', 'That approach is not authorized by the public affordance.') };
    if (affordance.targets.length > 1 && !proposal.target_id) return { ok: false, error: publicError('INVALID_INPUT', 'Clarify which listed target the players mean.') };
    if (affordance.approaches.length > 1 && !proposal.approach_id) return { ok: false, error: publicError('INVALID_INPUT', 'Clarify which listed approach the players mean.') };
    if (affordance.item_ids.length > 0 && !proposal.item_id) return { ok: false, error: publicError('INVALID_INPUT', 'Clarify which listed item the players mean.') };
  }
  return { ok: true, interaction: { ...proposal, action_text: userText.slice(0, USER_ACTION_TEXT_LIMIT) } as PlayerInteraction };
}

function ollamaActionTool(tool: OllamaTool, turn: PublicTurn): OllamaTool {
  const choiceIds = turn.choices.map(choice => choice.id);
  const affordanceIds = turn.affordances.map(affordance => affordance.id);
  const targetIds = [...new Set(turn.affordances.flatMap(affordance => affordance.targets.map(target => target.id)))];
  const ownedItems = new Set(turn.inventory.map(item => item.id));
  const itemIds = [...new Set(turn.affordances.flatMap(affordance => affordance.item_ids).filter(id => ownedItems.has(id)))];
  const approachIds = [...new Set(turn.affordances.flatMap(affordance => affordance.approaches.map(approach => approach.id)))];
  const enumString = (values: string[]) => ({ type: 'string', ...(values.length ? { enum: values } : {}) });
  return {
    ...tool,
    function: {
      ...tool.function,
      parameters: {
        type: 'object', additionalProperties: false, required: ['kind', 'action_text'],
        properties: {
          kind: { type: 'string', enum: ['choice', 'free_action'], description: 'Choose the interaction type.' },
          choice_id: { ...enumString(choiceIds), description: 'Use the ID of the one current public choice matching the players’ clear intent.' },
          affordance_id: { ...enumString(affordanceIds), description: 'Use an affordance ID from the current public turn for an unlisted action.' },
          target_id: { ...enumString(targetIds), description: 'Use only a target listed under the selected affordance.' },
          item_id: { ...enumString(itemIds), description: 'Use only an allowed item the party currently owns.' },
          approach_id: { ...enumString(approachIds), description: 'Use only an approach listed under the selected affordance.' },
          action_text: { type: 'string', minLength: 1, maxLength: USER_ACTION_TEXT_LIMIT, description: 'The player’s intent; the host binds the actual text.' },
        },
      },
    },
  };
}

function normalizeModelInteraction(input: Record<string, unknown>, userText: string): unknown {
  const actionText = userText.slice(0, USER_ACTION_TEXT_LIMIT);
  if (input.interaction && typeof input.interaction === 'object' && !Array.isArray(input.interaction)) {
    return { ...(input.interaction as Record<string, unknown>), action_text: actionText };
  }
  const interaction: Record<string, unknown> = { kind: input.kind, action_text: actionText };
  for (const key of ['choice_id', 'affordance_id', 'target_id', 'item_id', 'approach_id']) {
    if (key in input) interaction[key] = input[key];
  }
  return interaction;
}

export type ConversationHostOptions = {
  dataDir: string;
  ollama?: OllamaClient;
  mcp?: McpGateway;
  now?: () => string;
  createId?: () => string;
  trace?: (event: { component: 'ollama' | 'mcp' | 'conversation'; outcome: 'ok' | 'error'; name?: string; elapsed_ms?: number; code?: string }) => void;
};

/** Persistent language host. Game state and every mutation remain behind the MCP client boundary. */
export class ConversationHost {
  readonly store: JsonConversationStore;
  readonly ollama: OllamaClient;
  readonly mcp: McpGateway;
  private readonly now: () => string;
  private readonly createId: () => string;
  private readonly trace: NonNullable<ConversationHostOptions['trace']>;
  private readonly publicStateEvents = new EventEmitter();
  private promptCache: Partial<Record<'en' | 'es', string>> = {};

  constructor(options: ConversationHostOptions) {
    this.store = new JsonConversationStore(path.join(options.dataDir, 'conversations-v1'));
    this.ollama = options.ollama ?? new OllamaClient();
    this.mcp = options.mcp ?? new McpGateway();
    this.now = options.now ?? (() => new Date().toISOString());
    this.createId = options.createId ?? randomUUID;
    this.trace = options.trace ?? ((event) => console.info('[rpg-host]', JSON.stringify(event)));
  }

  private async prompt(locale: 'en' | 'es'): Promise<string> {
    if (this.promptCache[locale]) return this.promptCache[locale]!;
    const promptPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../prompts', `game-master.${locale}.md`);
    const contents = await readFile(promptPath, 'utf8');
    this.promptCache[locale] = contents;
    return contents;
  }

  private async applyExplicitGameAction(record: PersistedConversation, userText: string, requestId: string, signal?: AbortSignal): Promise<HostResponse | undefined> {
    const turn = record.turn;
    if (!record.session_id || !turn) return undefined;
    const choice = resolveExplicitPlayerChoice(turn, userText);
    const command = choice ? 'submit_action' : hasExplicitCheckIntent(turn, userText) ? 'resolve_check' : undefined;
    if (!command) return undefined;
    const args = command === 'submit_action'
      ? { session_id: record.session_id, expected_revision: turn.revision, request_id: requestId, interaction: { kind: 'choice', choice_id: choice!.id, action_text: userText.slice(0, USER_ACTION_TEXT_LIMIT) } }
      : { session_id: record.session_id, expected_revision: turn.revision, request_id: requestId, check_id: turn.pending_check!.id };
    const startedAt = Date.now();
    const result = await this.mcp.call(command, args, signal);
    this.trace({ component: 'mcp', outcome: result.isError ? 'error' : 'ok', name: command, elapsed_ms: Date.now() - startedAt });
    const next = asTurnResult(result);
    if (isError(next)) return responseError(next);
    if (next.session_id !== record.session_id) return responseError(publicError('INTERNAL_ERROR', 'The game service returned a different session.'));
    if (next.revision !== turn.revision + 1) return responseError(publicError('REVISION_CONFLICT', 'The game service returned an unexpected revision.', true, next.revision));
    return HostResponseSchema.parse({ kind: 'turn', conversation: responseConversation(record), turn: next, assistant_text: next.narration });
  }

  async createConversation(input: unknown): Promise<HostResponse> {
    try {
      const request = CreateConversationRequestSchema.parse(input);
      const fingerprint = hostFingerprint({ locale: request.locale, session_id: request.session_id ?? null });
      const conversationId = request.request_id;
      try {
        const existing = await this.store.get(conversationId);
        if (existing.create_fingerprint !== fingerprint) return responseError(publicError('IDEMPOTENCY_KEY_REUSED', 'request_id was already used to create a different conversation.'));
        return existing.turn
          ? HostResponseSchema.parse({ kind: 'turn', conversation: responseConversation(existing), turn: existing.turn, assistant_text: existing.turn.narration })
          : HostResponseSchema.parse({ kind: 'message', conversation: responseConversation(existing), assistant_text: this.welcome(existing.conversation.locale) });
      } catch (error) { if (!(error instanceof ConversationStoreError) || error.code !== 'NOT_FOUND') throw error; }

      let turn: PublicTurn | null = null;
      let sessionId: string | null = request.session_id ?? null;
      if (sessionId) {
        const response = await this.mcp.call('get_session', { session_id: sessionId });
        const parsed = asTurnResult(response);
        if (isError(parsed)) return responseError(parsed);
        if (parsed.session_id !== sessionId || parsed.locale !== request.locale || parsed.phase === 'busy') return responseError(publicError('INVALID_INPUT', 'The saved session cannot be linked with this locale or phase.'));
        turn = parsed;
      }
      const now = this.now();
      const record: PersistedConversation = {
        schema_version: 1,
        conversation: { conversation_id: conversationId, locale: request.locale, session_id: sessionId, paused: false, created_at: now },
        create_fingerprint: fingerprint,
        session_id: sessionId,
        turn,
        public_turns: turn ? [turn] : [],
        player_names: turn ? [] : [],
        catalogue: [],
        offered_adventure_ids: [],
        history: [], summary: turn?.recap ?? '', paused: false, idempotency: [], updated_at: now,
      };
      await this.store.create(record);
      return turn
        ? HostResponseSchema.parse({ kind: 'turn', conversation: responseConversation(record), turn, assistant_text: turn.narration })
        : HostResponseSchema.parse({ kind: 'message', conversation: responseConversation(record), assistant_text: this.welcome(request.locale) });
    } catch (error) {
      this.trace({ component: 'conversation', outcome: 'error', code: error instanceof ConversationStoreError ? error.code : 'create_failed' });
      return responseError(publicError('INTERNAL_ERROR', 'The conversation could not be created.', true));
    }
  }

  private welcome(locale: 'en' | 'es'): string {
    return locale === 'es'
      ? '¿Qué tipo de aventura os gustaría jugar y cómo se llaman los jugadores?'
      : 'What kind of adventure would you like to play, and what are the players’ names?';
  }

  async turn(conversationId: string, input: unknown, signal?: AbortSignal): Promise<HostResponse> {
    let request;
    try { request = PlayerTurnRequestSchema.parse(input); }
    catch { return responseError(publicError('INVALID_INPUT', 'The player turn request is invalid.')); }
    const requestFingerprint = hostFingerprint({ text: redactSecrets(request.text), expected_revision: request.expected_revision ?? null });
    try {
      const response = await this.store.update(conversationId, async (record) => {
        const prior = record.idempotency.find((entry) => entry.request_id === request.request_id);
        if (prior) return prior.fingerprint === requestFingerprint
          ? { record, value: prior.response }
          : { record, value: responseError(publicError('IDEMPOTENCY_KEY_REUSED', 'request_id was already used for another player turn.')) };
        const conversation = responseConversation(record);
        if (record.paused) {
          const response = HostResponseSchema.parse({ kind: 'message', conversation, assistant_text: record.conversation.locale === 'es' ? 'La conversación está en pausa. Reanúdala para continuar.' : 'This conversation is paused. Resume it to continue.' });
          return { record: this.withRecord(record, request.request_id, requestFingerprint, response), value: response };
        }
        const safeText = redactSecrets(request.text);
        if (record.session_id && record.turn) {
          if (request.expected_revision !== undefined && request.expected_revision !== record.turn.revision) {
            return { record, value: responseError(publicError('REVISION_CONFLICT', 'The conversation view is out of date.', true, record.turn.revision)) };
          }
          const latest = asTurnResult(await this.mcp.call('get_session', { session_id: record.session_id }, signal));
          if (isError(latest)) return { record, value: responseError(latest) };
          if (latest.session_id !== record.session_id) return { record, value: responseError(publicError('INTERNAL_ERROR', 'MCP returned a different session.', false)) };
          if (latest.revision !== record.turn.revision) {
            const updated = { ...record, turn: latest, summary: latest.recap, updated_at: this.now() };
            return { record: updated, value: responseError(publicError('REVISION_CONFLICT', 'The session changed; its latest turn has been restored. Retry with the current revision.', true, latest.revision)) };
          }
        } else if (request.expected_revision !== undefined) {
          return { record, value: responseError(publicError('REVISION_CONFLICT', 'There is no active session revision to match.', true, 0)) };
        }

        try {
          const completion = await this.runModelTurn(record, safeText, request.request_id, signal);
          const updated = this.applyCompletion(record, request.request_id, requestFingerprint, safeText, completion);
          return { record: updated, value: completion.response };
        } catch (error) {
          this.trace({ component: error instanceof McpGatewayError ? 'mcp' : 'ollama', outcome: 'error', code: error instanceof OllamaError || error instanceof McpGatewayError ? error.code : 'turn_failed' });
          return { record, value: responseError(publicError('INTERNAL_ERROR', error instanceof McpGatewayError ? 'The game service could not be reached.' : 'The conversational model could not complete this turn.', true)) };
        }
      });
      if (response.kind === 'turn' || response.kind === 'clarification') await this.publishPublicState(conversationId);
      return response;
    } catch (error) {
      this.trace({ component: 'conversation', outcome: 'error', code: error instanceof ConversationStoreError ? error.code : 'read_failed' });
      return responseError(publicError(error instanceof ConversationStoreError && error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL_ERROR', 'The conversation could not be loaded.', error instanceof ConversationStoreError && error.code !== 'NOT_FOUND'));
    }
  }

  async pause(conversationId: string, input: unknown): Promise<HostResponse> {
    return this.control(conversationId, input, true);
  }
  async resume(conversationId: string, input: unknown): Promise<HostResponse> {
    return this.control(conversationId, input, false);
  }

  /** Polls only the preparation operation durably associated with this conversation. */
  async getPendingOperation(conversationId: string): Promise<HostResponse> {
    let record: PersistedConversation;
    try { record = await this.store.get(conversationId); }
    catch (error) {
      return responseError(publicError(error instanceof ConversationStoreError && error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL_ERROR', 'The conversation could not be loaded.', error instanceof ConversationStoreError && error.code !== 'NOT_FOUND'));
    }
    const prior = this.latestPreparation(record);
    if (!prior) return responseError(publicError('NOT_FOUND', 'This conversation has no preparation operation.'));
    let operation = prior;
    if (prior.status === 'pending') {
      let result: Record<string, unknown>;
      try { result = await this.mcp.call('get_operation_status', { operation_id: prior.operation_id }); }
      catch { return responseError(publicError('INTERNAL_ERROR', 'The operation status could not be reached.', true)); }
      if (result.isError) {
        const parsedError = PublicErrorSchema.safeParse((result.structuredContent as { error?: unknown } | undefined)?.error);
        return responseError(parsedError.success ? parsedError.data : publicError('INTERNAL_ERROR', 'The operation status could not be read.', true));
      }
      const parsed = PublicOperationSchema.safeParse(result.structuredContent);
      if (!parsed.success || parsed.data.operation_id !== prior.operation_id || parsed.data.kind !== 'prepare_adventure') return responseError(publicError('INTERNAL_ERROR', 'The operation service returned an invalid status.'));
      operation = parsed.data;
    }
    let catalogue = record.catalogue;
    if (operation.status === 'ready') {
      try {
        const result = await this.mcp.call('list_adventures', { locale: record.conversation.locale });
        const parsed = ListAdventuresResponseSchema.safeParse(result.structuredContent);
        if (result.isError || !parsed.success) return responseError(publicError('INTERNAL_ERROR', 'The generated adventure could not be added to the public catalogue.', true));
        catalogue = parsed.data.adventures.filter((adventure) => adventure.locale === record.conversation.locale);
      } catch { return responseError(publicError('INTERNAL_ERROR', 'The generated adventure could not be added to the public catalogue.', true)); }
    }
    try {
      return await this.store.update(conversationId, (current) => {
        const response = HostResponseSchema.parse({ kind: 'operation', conversation: responseConversation(current), operation });
        let replaced = false;
        const idempotency = current.idempotency.map((entry) => {
          if (entry.response.kind === 'operation' && entry.response.operation.operation_id === operation.operation_id && !replaced) {
            replaced = true;
            return { ...entry, response };
          }
          return entry;
        });
        const offeredAdventureIds = operation.status === 'ready' && operation.result.kind === 'adventure'
          ? [operation.result.adventure_id]
          : current.offered_adventure_ids;
        const next = { ...current, idempotency, catalogue, offered_adventure_ids: offeredAdventureIds, updated_at: this.now() };
        return { record: next, value: HostResponseSchema.parse({ kind: 'operation', conversation: responseConversation(next), operation }) };
      });
    } catch { return responseError(publicError('INTERNAL_ERROR', 'The operation status could not be saved to this conversation.', true)); }
  }

  private async control(conversationId: string, input: unknown, paused: boolean): Promise<HostResponse> {
    const parsedInput = SessionControlRequestSchema.safeParse(input);
    if (!parsedInput.success) return responseError(publicError('INVALID_INPUT', 'The session control request is invalid.'));
    const commandFingerprint = hostFingerprint({ command: paused ? 'pause' : 'resume', expected_revision: parsedInput.data.expected_revision ?? null });
    try {
      const response = await this.store.update(conversationId, async (record) => {
        const previous = record.idempotency.find((entry) => entry.request_id === parsedInput.data.request_id);
        if (previous) return previous.fingerprint === commandFingerprint
          ? { record, value: previous.response }
          : { record, value: responseError(publicError('IDEMPOTENCY_KEY_REUSED', 'request_id was already used for another control request.')) };
        const current = responseConversation(record);
        if (parsedInput.data.expected_revision !== undefined && record.turn?.revision !== parsedInput.data.expected_revision) return { record, value: responseError(publicError('REVISION_CONFLICT', 'The conversation view is out of date.', true, record.turn?.revision ?? 0)) };
        let turn = record.turn;
        if (!paused && record.session_id) {
          const latest = asTurnResult(await this.mcp.call('get_session', { session_id: record.session_id }));
          if (isError(latest)) return { record, value: responseError(latest) };
          turn = latest;
        }
        const next = { ...record, paused, turn: turn ?? null, summary: turn?.recap ?? record.summary, updated_at: this.now() };
        const message = paused
          ? (record.conversation.locale === 'es' ? 'Partida en pausa. Tu progreso está guardado.' : 'The session is paused. Your progress is saved.')
          : (record.conversation.locale === 'es' ? 'La partida está lista para continuar.' : 'The session is ready to continue.');
        const response = turn
          ? HostResponseSchema.parse({ kind: 'turn', conversation: responseConversation(next), turn, assistant_text: message })
          : HostResponseSchema.parse({ kind: 'message', conversation: responseConversation(next), assistant_text: message });
        return { record: this.withRecord(next, parsedInput.data.request_id, commandFingerprint, response), value: response };
      });
      if (response.kind === 'turn') await this.publishPublicState(conversationId);
      return response;
    } catch (error) {
      return responseError(publicError(error instanceof ConversationStoreError && error.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'INTERNAL_ERROR', 'The conversation control request failed.', true));
    }
  }

  private withRecord(record: PersistedConversation, requestId: string, fingerprint: string, response: HostResponse): PersistedConversation {
    return { ...record, idempotency: [...record.idempotency, { request_id: requestId, fingerprint, response }].slice(-100), updated_at: this.now() };
  }

  private applyCompletion(record: PersistedConversation, requestId: string, fingerprint: string, userText: string, completion: { response: HostResponse; playerNames?: string[]; catalogue?: AdventureSummary[]; offeredAdventureIds?: string[] }): PersistedConversation {
    const turn = completion.response.kind === 'turn' || completion.response.kind === 'clarification' ? completion.response.turn : record.turn;
    const sessionId = turn?.session_id ?? record.session_id;
    let publicTurns = record.public_turns ?? [];
    if (turn) {
      const last = publicTurns.at(-1);
      if (!last || turn.revision > last.revision) publicTurns = [...publicTurns, turn].slice(-40);
      else if (turn.revision === last.revision) publicTurns = [...publicTurns.slice(0, -1), turn];
    }
    const updated = {
      ...record,
      conversation: { ...record.conversation, session_id: sessionId },
      session_id: sessionId,
      turn: turn ?? null,
      public_turns: publicTurns,
      player_names: completion.playerNames ?? record.player_names,
      catalogue: completion.catalogue ?? record.catalogue,
      offered_adventure_ids: completion.offeredAdventureIds ?? record.offered_adventure_ids,
      summary: turn?.recap ?? record.summary,
      history: [...record.history, { role: 'user' as const, content: userText }, { role: 'assistant' as const, content: completion.response.kind === 'turn' ? completion.response.assistant_text : completion.response.kind === 'message' ? completion.response.assistant_text : completion.response.kind === 'clarification' ? completion.response.question : '' }].filter((item) => item.content.length > 0).slice(-MAX_HISTORY),
      paused: false,
    };
    return this.withRecord({ ...updated, updated_at: this.now() }, requestId, fingerprint, completion.response);
  }

  async getPublicState(conversationId: string): Promise<HostPublicState | null> {
    try {
      const record = await this.store.get(conversationId);
      return HostPublicStateSchema.parse({
        conversation_id: conversationId,
        locale: record.conversation.locale,
        session_id: record.session_id,
        paused: record.paused,
        turn: record.turn,
        turns: record.public_turns ?? (record.turn ? [record.turn] : []),
      });
    } catch (error) {
      if (error instanceof ConversationStoreError && error.code === 'NOT_FOUND') return null;
      throw error;
    }
  }

  subscribePublicState(conversationId: string, listener: (state: HostPublicState) => void): () => void {
    this.publicStateEvents.on(conversationId, listener);
    return () => this.publicStateEvents.off(conversationId, listener);
  }

  private async publishPublicState(conversationId: string): Promise<void> {
    const state = await this.getPublicState(conversationId).catch(() => null);
    if (state) this.publicStateEvents.emit(conversationId, state);
  }

  private async runModelTurn(record: PersistedConversation, userText: string, requestId: string, signal?: AbortSignal): Promise<{ response: HostResponse; playerNames?: string[]; catalogue?: AdventureSummary[]; offeredAdventureIds?: string[] }> {
    const clarification = record.turn && explicitDisagreementQuestion(record.turn, userText, record.conversation.locale);
    if (clarification && record.turn) {
      return { response: HostResponseSchema.parse({ kind: 'clarification', conversation: responseConversation(record), turn: record.turn, question: clarification }), catalogue: record.catalogue };
    }
    const pendingPreparation = this.latestPreparation(record)?.status === 'pending';
    if (!record.session_id && !pendingPreparation && isExplicitNewAdventureRequest(userText, record.conversation.locale)) {
      const startedAt = Date.now();
      const result = await this.mcp.call('prepare_adventure', {
        request_id: requestId, premise: userText, locale: record.conversation.locale, preferences: {},
      }, signal);
      this.trace({ component: 'mcp', outcome: result.isError ? 'error' : 'ok', name: 'prepare_adventure', elapsed_ms: Date.now() - startedAt });
      if (result.isError) {
        const error = PublicErrorSchema.safeParse((result.structuredContent as { error?: unknown } | undefined)?.error ?? result.structuredContent);
        return { response: responseError(error.success ? error.data : publicError('OPERATION_FAILED', 'Adventure preparation is unavailable.')) };
      }
      const operation = PublicOperationSchema.safeParse(result.structuredContent);
      if (!operation.success || operation.data.kind !== 'prepare_adventure') {
        return { response: responseError(publicError('INTERNAL_ERROR', 'The adventure preparation service returned an invalid operation.')) };
      }
      return { response: HostResponseSchema.parse({ kind: 'operation', conversation: responseConversation(record), operation: operation.data }), catalogue: record.catalogue };
    }
    const explicitAction = await this.applyExplicitGameAction(record, userText, requestId, signal);
    if (explicitAction) return { response: explicitAction, catalogue: record.catalogue };
    const prompt = await this.prompt(record.conversation.locale);
    const pendingOperation = this.latestPreparation(record);
    const current = record.turn ? `Current public turn JSON (authoritative): ${JSON.stringify(record.turn)}` : 'No game session exists yet.';
    const operationContext = pendingOperation?.status === 'pending'
      ? `A preparation is pending and owned by this conversation: ${JSON.stringify({ operation_id: pendingOperation.operation_id, kind: pendingOperation.kind, status: pendingOperation.status })}. Use get_operation_status to check it if asked; do not prepare it again.`
      : '';
    const messages: OllamaMessage[] = [
      { role: 'system', content: `${prompt}\n\nConversation recap (player-visible only): ${record.summary || '(none)'}\n${current}\n${operationContext}` },
      ...record.history.slice(-MAX_HISTORY),
      { role: 'user', content: userText },
    ];
    const available = await this.availableTools(record);
    let catalogue = record.catalogue;
    let mutationSeen = false;
    let callsUsed = 0;
    let playerNames: string[] | undefined;
    const deadline = Date.now() + HOST_TURN_TIMEOUT_MS;
    for (let round = 0; round < HOST_MAX_MODEL_ROUNDS; round++) {
      if (signal?.aborted || Date.now() >= deadline) throw new OllamaError('timeout', 'The conversational turn timed out.');
      const started = Date.now();
      const turnSignal = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(Math.max(1, deadline - Date.now()))]);
      const answer = await this.ollama.chat({ messages, tools: round < HOST_MAX_MODEL_ROUNDS - 1 ? available : [], signal: turnSignal });
      this.trace({ component: 'ollama', outcome: 'ok', elapsed_ms: Date.now() - started });
      const calls = answer.tool_calls;
      if (calls.length === 0) {
        const text = redactSecrets(answer.content).trim();
        if (!text) throw new OllamaError('invalid_response', 'The model returned no player-facing text.');
        const offeredAdventureIds = catalogue.filter((adventure) => phraseIncluded(adventure.title, text) || phraseIncluded(adventure.id, text)).map((adventure) => adventure.id);
        const response = record.turn
          ? HostResponseSchema.parse({ kind: 'turn', conversation: responseConversation(record), turn: record.turn, assistant_text: text.slice(0, 2000) })
          : HostResponseSchema.parse({ kind: 'message', conversation: responseConversation(record), assistant_text: text.slice(0, 2000) });
        return { response, catalogue, offeredAdventureIds };
      }
      callsUsed += calls.length;
      if (round === HOST_MAX_MODEL_ROUNDS - 1) throw new OllamaError('timeout', 'The model exceeded the allowed tool rounds.');
      if (callsUsed > HOST_MAX_TOOL_CALLS || calls.some((call) => !MCP_TOOL_ALLOWLIST.has(call.name) && call.name !== CLARIFICATION_TOOL.function.name)) throw new OllamaError('invalid_response', 'The model requested an unsupported or excessive tool call.');
      if (calls.some((call) => call.name === CLARIFICATION_TOOL.function.name)) {
        if (calls.length !== 1) throw new OllamaError('invalid_response', 'A clarification must be the only tool call in the round.');
        const raw = calls[0]!.arguments;
        const parsed = raw && typeof raw === 'object' && !Array.isArray(raw)
          ? OllamaClarificationSchema.safeParse(raw)
          : OllamaClarificationSchema.safeParse(undefined);
        if (!parsed.success) throw new OllamaError('invalid_response', 'The clarification question was invalid.');
        const question = redactSecrets(parsed.data.question).trim().slice(0, 500);
        if (!question) throw new OllamaError('invalid_response', 'The clarification question was empty.');
        const response = record.turn
          ? HostResponseSchema.parse({ kind: 'clarification', conversation: responseConversation(record), turn: record.turn, question })
          : HostResponseSchema.parse({ kind: 'message', conversation: responseConversation(record), assistant_text: question });
        return { response, catalogue };
      }
      const mutations = calls.filter((call) => ['start_session', 'submit_action', 'resolve_check', 'end_session', 'prepare_adventure'].includes(call.name));
      if (mutations.length > 1 || (mutationSeen && mutations.length > 0)) throw new OllamaError('invalid_response', 'A player turn may authorize at most one mutation.');
      const mutationIndex = calls.findIndex((call) => ['start_session', 'submit_action', 'resolve_check', 'end_session', 'prepare_adventure'].includes(call.name));
      if (mutationIndex >= 0 && mutationIndex !== calls.length - 1) throw new OllamaError('invalid_response', 'A mutating tool call must be the final MCP call in a model round.');
      messages.push({ role: 'assistant', content: answer.content || 'Calling the requested game tool.' });
      for (const call of calls) {
        if (callsUsed + (call.name === 'start_session' ? 1 : 0) > HOST_MAX_TOOL_CALLS) throw new OllamaError('invalid_response', 'The turn exceeded the MCP call limit.');
        const { args, error } = await this.authorizeTool(record, call.name, call.arguments, userText, requestId, mutationSeen, catalogue);
        if (error) return { response: responseError(error) };
        if (call.name === 'start_session' && Array.isArray(args.players) && args.players.every((name) => typeof name === 'string')) {
          playerNames = [...args.players] as string[];
        }
        const startedAt = Date.now();
        const result = await this.mcp.call(call.name, args, turnSignal);
        this.trace({ component: 'mcp', outcome: result.isError ? 'error' : 'ok', name: call.name, elapsed_ms: Date.now() - startedAt });
        if (call.name === 'list_adventures') {
          const parsed = ListAdventuresResponseSchema.safeParse(result.structuredContent);
          if (!parsed.success) return { response: responseError(publicError('INTERNAL_ERROR', 'The game service returned an invalid adventure list.')) };
          catalogue = parsed.data.adventures.filter((adventure) => adventure.locale === record.conversation.locale);
        }
        if (call.name === 'prepare_adventure') {
          const preparedError = PublicErrorSchema.safeParse((result.structuredContent as { error?: unknown } | undefined)?.error ?? result.structuredContent);
          if (result.isError || preparedError.success) return { response: responseError(preparedError.success ? preparedError.data : publicError('OPERATION_FAILED', 'Adventure preparation is unavailable.', false)) };
          const operation = PublicOperationSchema.safeParse(result.structuredContent);
          if (operation.success) return { response: HostResponseSchema.parse({ kind: 'operation', conversation: responseConversation(record), operation: operation.data }) };
          messages.push({ role: 'tool', tool_name: call.name, content: JSON.stringify(toolPayload(result)) });
          continue;
        }
        if (call.name === 'get_operation_status') {
          const operation = PublicOperationSchema.safeParse(result.structuredContent);
          if (!operation.success) return { response: responseError(isError(result.structuredContent) ? result.structuredContent : publicError('INTERNAL_ERROR', 'The operation service returned an invalid public status.')) };
          if (operation.data.status !== 'ready') return { response: HostResponseSchema.parse({ kind: 'operation', conversation: responseConversation(record), operation: operation.data }) };
          if (callsUsed + 1 > HOST_MAX_TOOL_CALLS) throw new OllamaError('invalid_response', 'The turn exceeded the MCP call limit.');
          const listedResult = await this.mcp.call('list_adventures', { locale: record.conversation.locale }, turnSignal);
          const listed = ListAdventuresResponseSchema.safeParse(listedResult.structuredContent);
          if (listedResult.isError || !listed.success) return { response: responseError(publicError('INTERNAL_ERROR', 'The prepared adventure is not available in the public catalogue.', true)) };
          catalogue = listed.data.adventures.filter((adventure) => adventure.locale === record.conversation.locale);
          messages.push({ role: 'tool', tool_name: call.name, content: JSON.stringify(operation.data) });
          messages.push({ role: 'tool', tool_name: 'list_adventures', content: JSON.stringify({ adventures: catalogue }) });
          callsUsed++;
          continue;
        }
        const isMutation = ['start_session', 'submit_action', 'resolve_check', 'end_session'].includes(call.name);
        if (isMutation) {
          const parsed = asTurnResult(result);
          if (isError(parsed)) return { response: responseError(parsed) };
          const expectedSession = call.name === 'start_session' ? requestId : record.session_id;
          if (parsed.session_id !== expectedSession) return { response: responseError(publicError('INTERNAL_ERROR', 'The game service returned a different session.')) };
          const expectedRevision = call.name === 'start_session' ? 1 : (record.turn?.revision ?? 0) + 1;
          if (parsed.revision !== expectedRevision) return { response: responseError(publicError('REVISION_CONFLICT', 'The game service returned an unexpected revision.', true, parsed.revision)) };
          mutationSeen = true;
          messages.push({ role: 'tool', tool_name: call.name, content: JSON.stringify(parsed) });
        } else {
          if (call.name === 'get_session') {
            const parsed = asTurnResult(result);
            if (isError(parsed)) return { response: responseError(parsed) };
            if (parsed.session_id !== record.session_id || parsed.revision !== record.turn?.revision) return { response: responseError(publicError('REVISION_CONFLICT', 'The public session changed during this turn.', true, parsed.revision)) };
            messages.push({ role: 'tool', tool_name: call.name, content: JSON.stringify(parsed) });
          } else messages.push({ role: 'tool', tool_name: call.name, content: JSON.stringify(toolPayload(result)) });
        }
      }
      if (mutationSeen) {
        const startedAt = Date.now();
        const final = await this.ollama.chat({ messages, tools: [], signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(Math.max(1, deadline - Date.now()))]) });
        this.trace({ component: 'ollama', outcome: 'ok', elapsed_ms: Date.now() - startedAt });
        const text = redactSecrets(final.content).trim();
        if (!text) throw new OllamaError('invalid_response', 'The model returned no player-facing text after the game action.');
        const latestTurn = this.turnFromToolMessages(messages, record.turn);
        if (!latestTurn) throw new OllamaError('invalid_response', 'No public game turn followed the mutation.');
        const offeredAdventureIds = catalogue.filter((adventure) => phraseIncluded(adventure.title, text) || phraseIncluded(adventure.id, text)).map((adventure) => adventure.id);
        return {
          response: HostResponseSchema.parse({ kind: 'turn', conversation: { ...responseConversation(record), session_id: latestTurn.session_id }, turn: latestTurn, assistant_text: text.slice(0, 2000) }),
          catalogue, offeredAdventureIds, ...(playerNames ? { playerNames } : {}),
        };
      }
    }
    throw new OllamaError('timeout', 'The model did not finish within the allowed tool rounds.');
  }

  private turnFromToolMessages(messages: OllamaMessage[], prior: PublicTurn | null): PublicTurn | null {
    for (let index = messages.length - 1; index >= 0; index--) {
      const entry = messages[index]!;
      if (entry.role !== 'tool') continue;
      try {
        const parsed = PublicTurnSchema.safeParse(JSON.parse(entry.content));
        if (parsed.success) return parsed.data;
      } catch { /* only public structured turn tool results qualify */ }
    }
    return prior;
  }

  private async availableTools(record: PersistedConversation): Promise<OllamaTool[]> {
    const found = await this.mcp.ollamaTools();
    const allowed = new Set(['list_adventures']);
    const latestOperation = this.latestPreparation(record);
    if (latestOperation?.status === 'pending') allowed.add('get_operation_status');
    if (!record.session_id) { allowed.add('prepare_adventure'); allowed.add('start_session'); }
    if (record.session_id && record.turn) {
      allowed.add('get_session');
      if (record.turn.phase === 'awaiting_choice') allowed.add('submit_action');
      if (record.turn.phase === 'awaiting_check') allowed.add('resolve_check');
      allowed.add('end_session');
    }
    return [
      ...found.filter(({ function: fn }) => allowed.has(fn.name)).map(tool =>
        tool.function.name === 'submit_action' && record.turn ? ollamaActionTool(tool, record.turn) : tool),
      CLARIFICATION_TOOL,
    ];
  }

  private latestPreparation(record: PersistedConversation) {
    for (let index = record.idempotency.length - 1; index >= 0; index--) {
      const response = record.idempotency[index]!.response;
      if (response.kind === 'operation' && response.operation.kind === 'prepare_adventure') return response.operation;
    }
    return undefined;
  }

  private async authorizeTool(record: PersistedConversation, name: string, raw: unknown, userText: string, requestId: string, mutationPending: boolean, catalogue: AdventureSummary[]): Promise<{ args: Record<string, unknown>; error?: undefined } | { args?: undefined; error: PublicError }> {
    if (!MCP_TOOL_ALLOWLIST.has(name)) return { error: publicError('INVALID_INPUT', 'The requested tool is not available.') };
    const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? { ...(raw as Record<string, unknown>) } : {};
    if (name === 'list_adventures') {
      const parsed = ListAdventuresRequestSchema.safeParse({ ...input, locale: record.conversation.locale });
      return parsed.success ? { args: parsed.data } : { error: publicError('INVALID_INPUT', 'The adventure filter was invalid.') };
    }
    if (name === 'prepare_adventure') {
      if (mutationPending || record.session_id) return { error: publicError('INVALID_INPUT', 'Adventure preparation is not available during a session.') };
      const parsed = PrepareAdventureRequestSchema.safeParse({ ...input, request_id: requestId, locale: record.conversation.locale });
      return parsed.success ? { args: parsed.data } : { error: publicError('INVALID_INPUT', 'The preparation request was incomplete.') };
    }
    if (name === 'get_operation_status') {
      const operation = this.latestPreparation(record);
      if (!operation || operation.status !== 'pending') return { error: publicError('INVALID_INPUT', 'There is no pending preparation owned by this conversation.') };
      return { args: { operation_id: operation.operation_id } };
    }
    if (name === 'start_session') {
      if (mutationPending || record.session_id) return { error: publicError('INVALID_INPUT', 'A session is already active in this conversation.') };
      const selected = resolvePlayerAdventureSelection(record.offered_adventure_ids, userText, catalogue);
      if (!selected) return { error: publicError('INVALID_INPUT', 'Ask the players to select one of the adventures they were just offered.') };
      const parsed = StartSessionRequestSchema.safeParse({ ...input, adventure_id: selected.id, request_id: requestId, locale: record.conversation.locale });
      if (!parsed.success) return { error: publicError('INVALID_INPUT', 'Choose a listed adventure and provide the player names.') };
      const suppliedNames = [...record.history.filter((entry) => entry.role === 'user').map((entry) => entry.content), userText].join('\n');
      if (parsed.data.players.some((name) => !phraseIncluded(name, suppliedNames) || phraseNegated(name, suppliedNames))) return { error: publicError('INVALID_INPUT', 'Use only player names explicitly given in the conversation.') };
      const listResult = await this.mcp.call('list_adventures', { locale: record.conversation.locale });
      const list = ListAdventuresResponseSchema.safeParse(listResult.structuredContent);
      if (!list.success) return { error: publicError('INTERNAL_ERROR', 'The public adventure catalogue could not be validated.') };
      const selectedAdventure = list.data.adventures.find((adventure) => adventure.id === parsed.data.adventure_id && adventure.locale === record.conversation.locale);
      if (!selectedAdventure) return { error: publicError('NOT_FOUND', 'That adventure is not available in this language.') };
      return { args: parsed.data };
    }
    if (!record.session_id || !record.turn) return { error: publicError('INVALID_INPUT', 'There is no host-authorized session for this tool.') };
    if (name === 'get_session') return { args: { session_id: record.session_id } };
    if (mutationPending) return { error: publicError('INVALID_INPUT', 'Only one game mutation is allowed per player turn.') };
    if (name === 'submit_action') {
      const validated = validateInteractionAgainstTurn(record.turn, normalizeModelInteraction(input, userText), userText);
      if (!validated.ok) return { error: validated.error };
      const request = SubmitActionRequestSchema.safeParse({ session_id: record.session_id, expected_revision: record.turn.revision, request_id: requestId, interaction: validated.interaction });
      return request.success ? { args: request.data } : { error: publicError('INVALID_INPUT', 'The action request could not be validated.') };
    }
    if (name === 'resolve_check') {
      const check = record.turn.pending_check;
      if (record.turn.phase !== 'awaiting_check' || !check) return { error: publicError('INVALID_INPUT', 'There is no public pending check to resolve.') };
      const request = ResolveCheckRequestSchema.safeParse({ session_id: record.session_id, expected_revision: record.turn.revision, request_id: requestId, check_id: check.id });
      return request.success ? { args: request.data } : { error: publicError('INVALID_INPUT', 'The pending check could not be validated.') };
    }
    if (name === 'end_session') {
      if (!hasExplicitCloseIntent(userText)) return { error: publicError('INVALID_INPUT', 'The player has not clearly asked to end the session.') };
      const request = EndSessionRequestSchema.safeParse({ session_id: record.session_id, expected_revision: record.turn.revision, request_id: requestId });
      return request.success ? { args: request.data } : { error: publicError('INVALID_INPUT', 'The session closure could not be validated.') };
    }
    return { error: publicError('INVALID_INPUT', 'The requested tool is not available in this phase.') };
  }

  async close(): Promise<void> { await this.mcp.close(); }
}
