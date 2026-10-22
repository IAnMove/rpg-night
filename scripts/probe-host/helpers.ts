/**
 * Pure helpers for the local LLM -> MCP feasibility probe.
 * Importing this module must never start a server or call Ollama.
 */

export const DEFAULT_OLLAMA_BASE_URL = 'http://127.0.0.1:11434';
export const DEFAULT_OLLAMA_MODEL = 'qwen3:4b-instruct-2507-q4_K_M';
export const DEFAULT_TIMEOUT_MS = 45_000;
export const MAX_TOOL_ROUNDS = 3;
export const SESSION_ID_FIELD = 'session_id';

/** Exact tool catalog this probe is currently allowed to execute. */
export const ALLOWED_TOOL_NAMES = new Set([
  'start_adventure',
  'get_scene',
  'roll_dice',
  'player_action',
  'end_session',
]);

/** Tools that require a host-bound session_id before tools/call. */
export const TOOLS_REQUIRING_SESSION = new Set([
  'get_scene',
  'roll_dice',
  'player_action',
  'end_session',
]);

/** Tools that mutate session state on the current demo server. */
export const MUTATING_TOOLS = new Set([
  'start_adventure',
  'roll_dice',
  'player_action',
  'end_session',
]);

export type JsonSchemaObject = {
  type: 'object';
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
};

export type McpToolDef = {
  name: string;
  description?: string;
  inputSchema: JsonSchemaObject;
};

export type OllamaFunctionTool = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

export type ProbeCliOptions = {
  quick: boolean;
  timeoutMs: number;
  outputPath: string;
  model: string;
  baseUrl: string;
};

export type ExpectedIntentKind =
  | 'start_adventure'
  | 'get_scene'
  | 'roll_dice'
  | 'player_action';

export type ExpectedIntent = {
  kind: ExpectedIntentKind;
  /** Human-readable label for the report. */
  label: string;
  world?: 'fantasy' | 'space' | 'mystery';
  language?: 'en' | 'es';
  players?: string[];
  /** Exact current choice expected for a choice scenario. */
  choiceId?: string;
  /** When true, scene count must increase by exactly one. */
  requireSceneAdvance?: boolean;
  /** When true, revision must stay unchanged. */
  requireNoRevisionChange?: boolean;
};

export type TurnToolCallRecord = {
  name: string;
  arguments: Record<string, unknown>;
  isError?: boolean;
};

export type TurnInvariantInput = {
  expected: ExpectedIntent;
  toolCalls: TurnToolCallRecord[];
  revisionBefore: number | null;
  revisionAfter: number | null;
  scenesBefore: number | null;
  scenesAfter: number | null;
  boundSessionId: string | null;
};

export type TurnInvariantResult = {
  pass: boolean;
  failures: string[];
};

/**
 * Restrict the Ollama endpoint to loopback for this prototype.
 * Accepts http://127.0.0.1 or http://localhost with an optional port.
 */
export function assertLocalOllamaBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Invalid OLLAMA_BASE_URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`OLLAMA_BASE_URL must use http(s): ${raw}`);
  }
  const host = url.hostname.toLowerCase();
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '[::1]' && host !== '::1') {
    throw new Error(
      `OLLAMA_BASE_URL must point at a local Ollama service (127.0.0.1/localhost); got ${raw}`,
    );
  }
  // Normalize trailing slash away for stable fetch URLs.
  return url.origin;
}

/** Deep-clone a JSON-schema object and hide session_id from the model. */
export function omitSessionIdFromSchema(inputSchema: JsonSchemaObject): JsonSchemaObject {
  const properties: Record<string, unknown> = { ...(inputSchema.properties ?? {}) };
  delete properties[SESSION_ID_FIELD];
  const required = (inputSchema.required ?? []).filter((key) => key !== SESSION_ID_FIELD);
  const rest: Record<string, unknown> = { ...inputSchema };
  delete rest.properties;
  delete rest.required;
  const result: JsonSchemaObject = {
    ...rest,
    type: 'object',
    properties,
  };
  if (required.length > 0) result.required = required;
  return result;
}

/** Convert MCP listTools entries into Ollama native function tools (session_id omitted). */
export function mcpToolsToOllama(tools: McpToolDef[]): OllamaFunctionTool[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: omitSessionIdFromSchema(tool.inputSchema),
    },
  }));
}

/**
 * Strip any model-proposed session_id and inject the host-bound session.
 * Never trusts UUIDs invented by the model.
 */
export function prepareToolArguments(
  toolName: string,
  rawArgs: unknown,
  boundSessionId: string | null,
): { ok: true; arguments: Record<string, unknown> } | { ok: false; error: string } {
  if (!ALLOWED_TOOL_NAMES.has(toolName)) {
    return { ok: false, error: `Refusing unknown tool ${toolName}` };
  }
  if (rawArgs == null) {
    rawArgs = {};
  }
  if (typeof rawArgs !== 'object' || Array.isArray(rawArgs)) {
    return { ok: false, error: `Tool ${toolName} arguments must be a plain object` };
  }
  const args: Record<string, unknown> = { ...(rawArgs as Record<string, unknown>) };
  const modelProposed = args[SESSION_ID_FIELD];
  delete args[SESSION_ID_FIELD];

  if (TOOLS_REQUIRING_SESSION.has(toolName)) {
    if (!boundSessionId) {
      return {
        ok: false,
        error: `Refusing ${toolName}: no host-bound session_id (start_adventure must succeed first)`,
      };
    }
    if (typeof modelProposed === 'string' && modelProposed.length > 0 && modelProposed !== boundSessionId) {
      // Intentionally discarded — host binding wins.
    }
    args[SESSION_ID_FIELD] = boundSessionId;
  }

  return { ok: true, arguments: args };
}

/** True while the host may still issue another LLM round that can request tools. */
export function canContinueToolRounds(completedRounds: number, maxRounds = MAX_TOOL_ROUNDS): boolean {
  if (!Number.isInteger(completedRounds) || completedRounds < 0) {
    throw new Error(`completedRounds must be a non-negative integer, got ${completedRounds}`);
  }
  if (!Number.isInteger(maxRounds) || maxRounds < 1) {
    throw new Error(`maxRounds must be a positive integer, got ${maxRounds}`);
  }
  return completedRounds < maxRounds;
}

export function assertWithinToolRoundLimit(completedRounds: number, maxRounds = MAX_TOOL_ROUNDS): void {
  if (!canContinueToolRounds(completedRounds, maxRounds)) {
    throw new Error(`Tool round limit exceeded (max ${maxRounds} LLM tool rounds per human turn)`);
  }
}

/** Extract session.id only from structuredContent produced by a successful tool. */
export function sessionIdFromToolResult(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (!structured || typeof structured !== 'object') return null;
  const session = (structured as { session?: unknown }).session;
  if (!session || typeof session !== 'object') return null;
  const id = (session as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function revisionFromToolResult(result: unknown): number | null {
  if (!result || typeof result !== 'object') return null;
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (!structured || typeof structured !== 'object') return null;
  const session = (structured as { session?: unknown }).session;
  if (!session || typeof session !== 'object') return null;
  const revision = (session as { revision?: unknown }).revision;
  return typeof revision === 'number' && Number.isFinite(revision) ? revision : null;
}

export function scenesCountFromToolResult(result: unknown): number | null {
  if (!result || typeof result !== 'object') return null;
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (!structured || typeof structured !== 'object') return null;
  const session = (structured as { session?: unknown }).session;
  if (!session || typeof session !== 'object') return null;
  const scenes = (session as { scenes?: unknown }).scenes;
  return Array.isArray(scenes) ? scenes.length : null;
}

export function narrationFromToolResult(result: unknown): string | null {
  if (!result || typeof result !== 'object') return null;
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (!structured || typeof structured !== 'object') return null;
  const session = (structured as { session?: unknown }).session;
  if (!session || typeof session !== 'object') return null;
  const scenes = (session as { scenes?: unknown }).scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) return null;
  const last = scenes[scenes.length - 1];
  if (!last || typeof last !== 'object') return null;
  const narration = (last as { narration?: unknown }).narration;
  return typeof narration === 'string' ? narration : null;
}

export function choicesFromToolResult(result: unknown): Array<{ id: string; text: string }> {
  if (!result || typeof result !== 'object') return [];
  const structured = (result as { structuredContent?: unknown }).structuredContent;
  if (!structured || typeof structured !== 'object') return [];
  const session = (structured as { session?: unknown }).session;
  if (!session || typeof session !== 'object') return [];
  const scenes = (session as { scenes?: unknown }).scenes;
  if (!Array.isArray(scenes) || scenes.length === 0) return [];
  const last = scenes[scenes.length - 1];
  if (!last || typeof last !== 'object') return [];
  const choices = (last as { choices?: unknown }).choices;
  if (!Array.isArray(choices)) return [];
  return choices
    .filter((c): c is { id: string; text: string } =>
      !!c && typeof c === 'object' && typeof (c as { id?: unknown }).id === 'string' && typeof (c as { text?: unknown }).text === 'string')
    .map((c) => ({ id: c.id, text: c.text }));
}

/**
 * Evaluate probe invariants for one synthetic player turn.
 * Does not parse free-form model text to decide which tool should have run.
 */
export function evaluateTurnInvariants(input: TurnInvariantInput): TurnInvariantResult {
  const failures: string[] = [];
  const names = input.toolCalls.map((c) => c.name);
  const successful = input.toolCalls.filter((c) => !c.isError);
  const successfulMutations = successful.filter((c) => MUTATING_TOOLS.has(c.name));
  const countNamed = (name: string) => input.toolCalls.filter((c) => c.name === name).length;
  const successfulNamed = (name: string) => successful.filter((c) => c.name === name).length;

  for (const call of input.toolCalls) {
    if (call.isError) failures.push(`Tool ${call.name} returned an error`);
    if (!ALLOWED_TOOL_NAMES.has(call.name)) failures.push(`Unexpected unknown tool ${call.name}`);
  }

  if (input.expected.kind === 'start_adventure') {
    if (countNamed('start_adventure') !== 1 || successfulNamed('start_adventure') !== 1) {
      failures.push('Expected exactly one successful start_adventure call');
    }
    if (successfulMutations.some((c) => c.name !== 'start_adventure')) {
      failures.push('Unexpected mutation(s) besides start_adventure');
    }
    const start = successful.find((c) => c.name === 'start_adventure');
    if (start) {
      for (const field of ['world', 'language'] as const) {
        const expectedValue = input.expected[field];
        if (expectedValue !== undefined && start.arguments[field] !== expectedValue) {
          failures.push(`start_adventure ${field} did not match expected ${expectedValue}`);
        }
      }
      if (input.expected.players !== undefined &&
          JSON.stringify(start.arguments.players) !== JSON.stringify(input.expected.players)) {
        failures.push('start_adventure players did not match the expected player list');
      }
    }
    if (!input.boundSessionId) failures.push('start_adventure did not bind a session.id from structuredContent');
  } else if (input.expected.kind === 'roll_dice') {
    const rolls = input.toolCalls.filter((c) => c.name === 'roll_dice');
    if (rolls.length !== 1 || successfulNamed('roll_dice') !== 1) {
      failures.push('Expected exactly one successful roll_dice call');
    }
    const roll = successful.find((c) => c.name === 'roll_dice');
    if (roll) {
      if (roll.arguments.sides !== 20) failures.push('roll_dice sides must be 20 for this scenario');
      if (roll.arguments.count !== undefined && roll.arguments.count !== 1) {
        failures.push('roll_dice count must be omitted or 1 for this scenario');
      }
      if (roll.arguments.modifier !== undefined && roll.arguments.modifier !== 0) {
        failures.push('roll_dice modifier must be omitted or 0 for this scenario');
      }
    }
    if (successfulMutations.some((c) => c.name !== 'roll_dice')) {
      failures.push('Unexpected mutation(s) besides roll_dice');
    }
    if (input.revisionBefore == null || input.revisionAfter == null) {
      failures.push('Missing revision before/after for dice turn');
    } else if (input.revisionAfter !== input.revisionBefore + 1) {
      failures.push(`Expected one revision advance for dice (${input.revisionBefore} -> ${input.revisionBefore + 1}), got ${input.revisionAfter}`);
    }
    if (input.scenesBefore == null || input.scenesAfter == null) {
      failures.push('Missing scene counts before/after for dice turn');
    } else if (input.scenesAfter !== input.scenesBefore) {
      failures.push(`Dice turn must not add a scene (${input.scenesBefore} -> ${input.scenesAfter})`);
    }
  } else if (input.expected.kind === 'player_action') {
    const actions = input.toolCalls.filter((c) => c.name === 'player_action');
    if (actions.length !== 1 || successfulNamed('player_action') !== 1) {
      failures.push('Expected exactly one successful player_action call');
    }
    const action = successful.find((c) => c.name === 'player_action');
    if (action && input.expected.choiceId !== undefined && action.arguments.choice_id !== input.expected.choiceId) {
      failures.push(`player_action choice_id did not match expected ${input.expected.choiceId}`);
    }
    if (successfulMutations.some((c) => c.name !== 'player_action')) {
      failures.push('Unexpected mutation(s) besides player_action');
    }
    if (input.revisionBefore == null || input.revisionAfter == null) {
      failures.push('Missing revision before/after for choice turn');
    } else if (input.revisionAfter !== input.revisionBefore + 1) {
      failures.push(`Expected one revision advance for choice (${input.revisionBefore} -> ${input.revisionBefore + 1}), got ${input.revisionAfter}`);
    }
    if (input.scenesBefore == null || input.scenesAfter == null) {
      failures.push('Missing scene counts before/after for choice turn');
    } else if (input.scenesAfter !== input.scenesBefore + 1) {
      failures.push(`Expected exactly one scene advance (${input.scenesBefore} -> ${input.scenesBefore + 1}), got ${input.scenesAfter}`);
    }
  } else if (input.expected.kind === 'get_scene') {
    if (successfulNamed('get_scene') < 1) failures.push('get_scene did not succeed');
    if (successfulMutations.length > 0) {
      failures.push(`Unexpected mutating tool(s) on read-only turn: ${successfulMutations.map((c) => c.name).join(', ')}`);
    }
    if (input.revisionBefore == null || input.revisionAfter == null) {
      failures.push('Missing revision before/after for a read-only expectation');
    } else if (input.revisionAfter !== input.revisionBefore) {
      failures.push(`Unexpected revision advance on read: ${input.revisionBefore} -> ${input.revisionAfter}`);
    }
    if (input.scenesBefore != null && input.scenesAfter != null && input.scenesAfter !== input.scenesBefore) {
      failures.push(`Read-only turn changed scene count (${input.scenesBefore} -> ${input.scenesAfter})`);
    }
  }

  return { pass: failures.length === 0, failures };
}

export function parseProbeArgs(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
): ProbeCliOptions {
  let quick = false;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let outputPath = pathJoinWork('report.json');
  let model = env.OLLAMA_MODEL?.trim() || DEFAULT_OLLAMA_MODEL;
  let baseUrl = assertLocalOllamaBaseUrl(env.OLLAMA_BASE_URL?.trim() || DEFAULT_OLLAMA_BASE_URL);

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--quick') {
      quick = true;
      continue;
    }
    if (arg === '--timeout-ms') {
      const raw = argv[++i];
      const value = Number(raw);
      if (!raw || !Number.isInteger(value) || value < 1000) {
        throw new Error(`--timeout-ms requires an integer >= 1000, got ${raw}`);
      }
      timeoutMs = value;
      continue;
    }
    if (arg === '--output') {
      const raw = argv[++i];
      if (!raw) throw new Error('--output requires a path');
      outputPath = raw;
      continue;
    }
    if (arg === '--model') {
      const raw = argv[++i];
      if (!raw) throw new Error('--model requires a value');
      model = raw;
      continue;
    }
    if (arg === '--base-url') {
      const raw = argv[++i];
      if (!raw) throw new Error('--base-url requires a value');
      baseUrl = assertLocalOllamaBaseUrl(raw);
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      throw new Error(
        'Usage: npx tsx scripts/probe-host.ts [--quick] [--timeout-ms N] [--output path] [--model name] [--base-url url]',
      );
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { quick, timeoutMs, outputPath, model, baseUrl };
}

function pathJoinWork(file: string): string {
  // Keep default report under .work/feasibility without importing node:path here for testability.
  return `.work/feasibility/${file}`;
}

/** Full scenario script (English + Spanish). */
export function fullScenarioTurns(): Array<{ player: string; language: 'en' | 'es'; expected: ExpectedIntent }> {
  return [
    {
      player: 'Start a fantasy adventure in English for Mira and Leo.',
      language: 'en',
      expected: {
        kind: 'start_adventure',
        label: 'english_start_fantasy_mira_leo',
        world: 'fantasy',
        language: 'en',
        players: ['Mira', 'Leo'],
      },
    },
    {
      player: 'What is in our inventory right now? Just read it; do not advance the story.',
      language: 'en',
      expected: {
        kind: 'get_scene',
        label: 'english_inventory_read',
        requireNoRevisionChange: true,
      },
    },
    {
      player: 'Please roll a d20 for us.',
      language: 'en',
      expected: {
        kind: 'roll_dice',
        label: 'english_roll_d20',
      },
    },
    {
      player: 'Choose option two from the current choices and take that action.',
      language: 'en',
      expected: {
        kind: 'player_action',
        label: 'english_choose_option_two',
        requireSceneAdvance: true,
      },
    },
    {
      player: 'Empieza una aventura de misterio en español para Ana.',
      language: 'es',
      expected: {
        kind: 'start_adventure',
        label: 'spanish_start_mystery_ana',
        world: 'mystery',
        language: 'es',
        players: ['Ana'],
      },
    },
    {
      player: 'Repite las opciones actuales sin avanzar la historia.',
      language: 'es',
      expected: {
        kind: 'get_scene',
        label: 'spanish_repeat_options',
        requireNoRevisionChange: true,
      },
    },
  ];
}

/** --quick subset: English start, inventory, dice. */
export function quickScenarioTurns(): Array<{ player: string; language: 'en' | 'es'; expected: ExpectedIntent }> {
  return fullScenarioTurns().slice(0, 3);
}

export const SYSTEM_PROMPT = [
  'You are the conversational host for RPG Night. Follow the player’s intent and use tools as the authority for game state.',
  'For a request to inspect or repeat current game information, read the current state and answer from that result without changing it.',
  'A read from get_scene is not completion of a request to take an action. If a read is needed to identify the requested current choice, continue the same request after reading and call player_action exactly once.',
  'Resolve a numbered or referenced choice only against the current choices returned by a tool. Pass that choice’s exact choice_id to player_action; never guess, substitute, or fabricate an ID.',
  'When the player clearly requests a state change, invoke the appropriate tool once; a read may precede it but cannot replace it. Never make more than one state-changing call for a request or repeat a mutation to embellish the story.',
  'Use only tool-returned facts for scenes, choices, items, inventory, dice, outcomes, and consequences. Never invent, add, remove, or alter any of them.',
  'For a free-form action, pass only the player’s stated intent to the action tool. If the intent or a required choice reference cannot be resolved safely from current state, ask a concise clarification without changing game state.',
  'Use the dice tool only when the player asks for a roll. A die result alone does not establish a story outcome; report only consequences confirmed by a tool.',
  'Keep narration concise, in the player’s language, and grounded in tool results. Do not expose tool names, internal choice IDs, session IDs, or other private identifiers.',
  'The host supplies the bound session_id to tools. Never invent or change session IDs.',
].join(' ');
