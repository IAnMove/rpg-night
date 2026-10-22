/**
 * Feasibility probe: local Ollama LLM -> official MCP client -> demo game tools.
 *
 * Proves tool discovery, session_id host injection, real tools/call over HTTP,
 * and model-generated narration after tool facts. Does NOT certify narration
 * fidelity, the future 8-tool
 * contract or final conversational quality.
 *
 * Run: npx tsx scripts/probe-host.ts [--quick] [--timeout-ms N] [--output path]
 */
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createApp, errorHandler } from '../mcp-server/app.js';
import { readConfig } from '../mcp-server/config.js';
import { Game } from '../mcp-server/game.js';
import { DemoProvider } from '../mcp-server/providers.js';
import {
  SYSTEM_PROMPT,
  assertLocalOllamaBaseUrl,
  canContinueToolRounds,
  choicesFromToolResult,
  evaluateTurnInvariants,
  fullScenarioTurns,
  mcpToolsToOllama,
  parseProbeArgs,
  prepareToolArguments,
  quickScenarioTurns,
  revisionFromToolResult,
  scenesCountFromToolResult,
  sessionIdFromToolResult,
  type ExpectedIntent,
  type McpToolDef,
  type OllamaFunctionTool,
  type ProbeCliOptions,
  type TurnToolCallRecord,
} from './probe-host/helpers.js';

type OllamaMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
};

type OllamaToolCall = {
  type?: string;
  function: {
    name: string;
    arguments: Record<string, unknown> | string;
  };
};

type OllamaChatResponse = {
  message?: OllamaMessage;
  error?: string;
};

type TurnReport = {
  id: string;
  player: string;
  language: 'en' | 'es';
  expectedIntent: string;
  expectedKind: ExpectedIntent['kind'];
  latencyMs: number;
  modelLatencyMs: number;
  isFirstModelRequest: boolean;
  toolCalls: Array<{
    name: string;
    arguments: Record<string, unknown>;
    isError: boolean;
    resultPreview: string;
  }>;
  narration: string;
  revisionBefore: number | null;
  revisionAfter: number | null;
  scenesBefore: number | null;
  scenesAfter: number | null;
  pass: boolean;
  errors: string[];
  narrationReview: 'manual_review_required';
};

type ProbeReport = {
  timestamp: string;
  model: string;
  ollamaBaseUrl: string;
  thinkSupported: boolean | null;
  discoveredTools: Array<{ name: string; description?: string }>;
  dataDir: string;
  serverBaseUrl: string;
  mcpProtocolVersion: string | null;
  turns: TurnReport[];
  summary: {
    passed: number;
    failed: number;
    total: number;
    firstModelLatencyMs: number | null;
    subsequentLatenciesMs: number[];
    ok: boolean;
  };
  errors: string[];
};

type OwnedHarness = {
  dataDir: string;
  baseUrl: string;
  server: http.Server;
  client: Client;
  protocolVersion: string | null;
  close: () => Promise<void>;
};

function log(message: string): void {
  console.log(`[probe-host] ${message}`);
}

function previewText(value: unknown, max = 280): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '';
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}

function parseToolArguments(raw: Record<string, unknown> | string): unknown {
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as unknown;
    } catch {
      throw new Error('Tool arguments are not valid JSON');
    }
  }
  return raw;
}

async function ensureOllamaAvailable(baseUrl: string, model: string, timeoutMs: number): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, 10_000));
  try {
    const response = await fetch(`${baseUrl}/api/tags`, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`Ollama /api/tags returned HTTP ${response.status}`);
    }
    const body = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
    const names = (body.models ?? []).flatMap((m) => [m.name, m.model].filter(Boolean) as string[]);
    const found = names.some((n) => n === model || n === `${model}:latest`);
    if (!found) {
      throw new Error(
        `Ollama is up at ${baseUrl} but model ${model} is not listed in /api/tags. Available: ${names.join(', ') || '(none)'}`,
      );
    }
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Ollama unavailable at ${baseUrl} (timeout contacting /api/tags)`);
    }
    if (error instanceof TypeError) {
      throw new Error(`Ollama unavailable at ${baseUrl}: ${error.message}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function ollamaChat(options: {
  baseUrl: string;
  model: string;
  messages: OllamaMessage[];
  tools: OllamaFunctionTool[];
  timeoutMs: number;
  think: boolean | null;
  numPredict?: number;
}): Promise<{ response: OllamaChatResponse; thinkSupported: boolean | null }> {
  const { baseUrl, model, messages, tools, timeoutMs, numPredict = 512 } = options;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const buildBody = (think: boolean | null) => {
    const body: Record<string, unknown> = {
      model,
      messages,
      tools,
      stream: false,
      options: { num_predict: numPredict, temperature: 0 },
    };
    if (think !== null) body.think = think;
    return body;
  };

  try {
    let thinkFlag = options.think;
    let response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildBody(thinkFlag)),
      signal: controller.signal,
    });

    // If think is rejected by this Ollama build, retry once without it and document.
    if (!response.ok) {
      const errText = await response.text();
      if (thinkFlag !== null && /think/i.test(errText)) {
        thinkFlag = null;
        response = await fetch(`${baseUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(buildBody(null)),
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(`Ollama /api/chat HTTP ${response.status}: ${previewText(await response.text(), 400)}`);
        }
        const json = (await response.json()) as OllamaChatResponse;
        if (json.error) throw new Error(`Ollama error: ${json.error}`);
        return { response: json, thinkSupported: false };
      }
      throw new Error(`Ollama /api/chat HTTP ${response.status}: ${previewText(errText, 400)}`);
    }

    const json = (await response.json()) as OllamaChatResponse;
    if (json.error) throw new Error(`Ollama error: ${json.error}`);
    return { response: json, thinkSupported: thinkFlag === null ? null : true };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`Ollama /api/chat timed out after ${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function startIsolatedHarness(): Promise<OwnedHarness> {
  const dataDir = path.resolve('.work', 'feasibility', `session-${randomUUID()}`);
  await mkdir(dataDir, { recursive: true });

  // Bind an ephemeral port via listen(0); config.PORT is unused by this harness.
  const config = readConfig({
    PROVIDER: 'demo',
    DATA_DIR: dataDir,
    HOST: '127.0.0.1',
  });
  const game = new Game(config, new DemoProvider());
  await game.init();
  const app = createApp(config, game);
  app.use(errorHandler);

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', () => resolve());
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Failed to bind isolated probe server on an ephemeral port');
  }
  const baseUrl = `http://127.0.0.1:${address.port}`;

  const client = new Client({ name: 'rpg-night-probe-host', version: '0.1.0' });

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      await client.close();
    } catch {
      // ignore client close errors during shutdown
    }
    await new Promise<void>((resolve) => {
      try {
        server.closeAllConnections();
      } catch {
        // older Node without closeAllConnections — close() is enough
      }
      server.close(() => resolve());
    });
  };

  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`));
  try {
    await client.connect(transport);
  } catch (error) {
    await close();
    throw error;
  }
  return { dataDir, baseUrl, server, client, protocolVersion: transport.protocolVersion ?? null, close };
}

async function runPlayerTurn(options: {
  client: Client;
  ollamaTools: OllamaFunctionTool[];
  baseUrl: string;
  model: string;
  timeoutMs: number;
  player: string;
  language: 'en' | 'es';
  expected: ExpectedIntent;
  boundSessionId: string | null;
  messages: OllamaMessage[];
  thinkSupported: boolean | null;
  isFirstModelRequest: boolean;
  latestRevision: number | null;
  latestScenes: number | null;
  latestChoices: Array<{ id: string; text: string }>;
}): Promise<{
  turn: TurnReport;
  boundSessionId: string | null;
  messages: OllamaMessage[];
  thinkSupported: boolean | null;
  latestRevision: number | null;
  latestScenes: number | null;
  latestChoices: Array<{ id: string; text: string }>;
  modelLatencyMs: number;
}> {
  const {
    client,
    ollamaTools,
    baseUrl,
    model,
    timeoutMs,
    player,
    language,
    expected,
    isFirstModelRequest,
  } = options;
  let boundSessionId = options.boundSessionId;
  let thinkSupported = options.thinkSupported;
  let latestRevision = options.latestRevision;
  let latestScenes = options.latestScenes;
  let latestChoices = options.latestChoices;
  const messages = [...options.messages];

  const revisionBefore = latestRevision;
  const scenesBefore = latestScenes;
  const toolCallRecords: TurnToolCallRecord[] = [];
  const toolCallReport: TurnReport['toolCalls'] = [];
  const errors: string[] = [];
  let narration = '';

  const contextBits: string[] = [];
  if (boundSessionId) contextBits.push(`A session is already bound by the host.`);
  // Keep cached choices for assertions, not model input. Asking tools for their
  // current state avoids treating a host-provided hint as an executed action.
  const userContent = [
    `Player (${language}): ${player}`,
    contextBits.length ? contextBits.join('\n') : '',
  ]
    .filter(Boolean)
    .join('\n\n');

  messages.push({ role: 'user', content: userContent });

  const started = Date.now();
  let modelLatencyMs = 0;
  let rounds = 0;

  try {
  while (true) {
    const chatStarted = Date.now();
    const { response, thinkSupported: thinkFlag } = await ollamaChat({
      baseUrl,
      model,
      messages,
      tools: ollamaTools,
      timeoutMs,
      think: thinkSupported === false ? null : false,
    });
    if (thinkSupported === null && thinkFlag !== null) thinkSupported = thinkFlag;
    if (thinkSupported === true && thinkFlag === false) thinkSupported = false;
    modelLatencyMs += Date.now() - chatStarted;

    const assistant = response.message;
    if (!assistant) {
      errors.push('Ollama returned no message');
      break;
    }

    const toolCalls = assistant.tool_calls ?? [];
    messages.push({
      role: 'assistant',
      content: assistant.content ?? '',
      ...(toolCalls.length ? { tool_calls: toolCalls } : {}),
    });

    if (toolCalls.length === 0) {
      if (assistant.content?.trim()) narration = assistant.content.trim();
      break;
    }

    if (toolCalls.length > 4) {
      errors.push('Stopped: model requested more than four tools in one round');
      break;
    }

    // Cap tool-bearing LLM rounds; still allow a later narration-only call after tools.
    if (!canContinueToolRounds(rounds)) {
      errors.push(`Stopped: exceeded max LLM tool rounds for this human turn`);
      break;
    }
    rounds += 1;

    for (const call of toolCalls) {
      const name = call.function?.name;
      if (!name) {
        errors.push('Tool call missing function name');
        continue;
      }
      const prepared = prepareToolArguments(name, parseToolArguments(call.function.arguments), boundSessionId);
      if (!prepared.ok) {
        errors.push(prepared.error);
        toolCallRecords.push({ name, arguments: {}, isError: true });
        toolCallReport.push({
          name,
          arguments: {},
          isError: true,
          resultPreview: prepared.error,
        });
        messages.push({
          role: 'tool',
          tool_name: name,
          content: JSON.stringify({ error: prepared.error }),
        });
        continue;
      }

      log(`tools/call ${name} ${previewText(prepared.arguments, 120)}`);
      let result: unknown;
      try {
        result = await client.callTool({ name, arguments: prepared.arguments });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        errors.push(`MCP callTool(${name}) failed: ${message}`);
        toolCallRecords.push({ name, arguments: prepared.arguments, isError: true });
        toolCallReport.push({
          name,
          arguments: prepared.arguments,
          isError: true,
          resultPreview: message,
        });
        messages.push({ role: 'tool', tool_name: name, content: JSON.stringify({ error: message }) });
        continue;
      }

      const isError = Boolean((result as { isError?: boolean }).isError);
      const preview =
        (result as { content?: Array<{ text?: string }> }).content?.map((c) => c.text ?? '').join('\n') ||
        previewText(result);

      toolCallRecords.push({ name, arguments: prepared.arguments, isError });
      toolCallReport.push({
        name,
        arguments: prepared.arguments,
        isError,
        resultPreview: previewText(preview, 320),
      });

      if (isError) {
        errors.push(`Tool ${name} returned isError: ${previewText(preview, 200)}`);
      } else {
        if (name === 'start_adventure') {
          const id = sessionIdFromToolResult(result);
          if (!id) {
            errors.push('start_adventure succeeded without structuredContent.session.id');
          } else {
            boundSessionId = id;
            log(`bound session.id=${id}`);
          }
        }
        const rev = revisionFromToolResult(result);
        const scenes = scenesCountFromToolResult(result);
        if (rev != null) latestRevision = rev;
        if (scenes != null) latestScenes = scenes;
        const choices = choicesFromToolResult(result);
        latestChoices = choices;
      }

      messages.push({
        role: 'tool',
        tool_name: name,
        content: typeof preview === 'string' ? preview : JSON.stringify(result),
      });
    }
  }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const invariant = evaluateTurnInvariants({
    expected,
    toolCalls: toolCallRecords,
    revisionBefore,
    revisionAfter: latestRevision,
    scenesBefore,
    scenesAfter: latestScenes,
    boundSessionId,
  });
  if (!invariant.pass) errors.push(...invariant.failures);
  if (!narration) errors.push('Model produced no final narration after tools');

  const turn: TurnReport = {
    id: expected.label,
    player,
    language,
    expectedIntent: expected.label,
    expectedKind: expected.kind,
    latencyMs: Date.now() - started,
    modelLatencyMs,
    isFirstModelRequest,
    toolCalls: toolCallReport,
    narration,
    revisionBefore,
    revisionAfter: latestRevision,
    scenesBefore,
    scenesAfter: latestScenes,
    pass: invariant.pass && !toolCallRecords.some((c) => c.isError && c.name === expected.kind),
    errors: [...new Set(errors)],
    narrationReview: 'manual_review_required',
  };
  // Recompute pass from accumulated errors for honesty.
  turn.pass = turn.errors.length === 0;

  return {
    turn,
    boundSessionId,
    messages,
    thinkSupported,
    latestRevision,
    latestScenes,
    latestChoices,
    modelLatencyMs,
  };
}

async function runProbe(cli: ProbeCliOptions): Promise<ProbeReport> {
  const baseUrl = assertLocalOllamaBaseUrl(cli.baseUrl);
  const reportErrors: string[] = [];
  let thinkSupported: boolean | null = null;
  let harness: OwnedHarness | null = null;
  const turns: TurnReport[] = [];
  let discoveredTools: ProbeReport['discoveredTools'] = [];
  const latencies: number[] = [];

  log(`model=${cli.model} base=${baseUrl} timeoutMs=${cli.timeoutMs} quick=${cli.quick}`);

  try {
    await ensureOllamaAvailable(baseUrl, cli.model, cli.timeoutMs);
    harness = await startIsolatedHarness();
    log(`isolated server ${harness.baseUrl} data=${harness.dataDir}`);

    const listed = await harness.client.listTools();
    const mcpTools: McpToolDef[] = listed.tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema as McpToolDef['inputSchema'],
    }));
    discoveredTools = mcpTools.map((t) => ({ name: t.name, description: t.description }));
    log(`discovered tools: ${discoveredTools.map((t) => t.name).join(', ')}`);
    const ollamaTools = mcpToolsToOllama(mcpTools);

    const scenario = cli.quick ? quickScenarioTurns() : fullScenarioTurns();
    let boundSessionId: string | null = null;
    let latestRevision: number | null = null;
    let latestScenes: number | null = null;
    let latestChoices: Array<{ id: string; text: string }> = [];
    let firstModel = true;

    for (const step of scenario) {
      log(`turn: ${step.expected.label}`);
      // Synthetic turns are independent requests with a bound session, not a
      // conversational-memory benchmark. Expected answers never reach the model.
      const turnMessages: OllamaMessage[] = [
        { role: 'system', content: SYSTEM_PROMPT },
      ];
      const expected = step.expected.requireSceneAdvance
        ? { ...step.expected, choiceId: latestChoices[1]?.id }
        : step.expected;
      if (step.expected.requireSceneAdvance && !expected.choiceId) {
        throw new Error('Choice scenario has no current second choice to validate');
      }

      const result = await runPlayerTurn({
        client: harness.client,
        ollamaTools,
        baseUrl,
        model: cli.model,
        timeoutMs: cli.timeoutMs,
        player: step.player,
        language: step.language,
        expected,
        boundSessionId,
        messages: turnMessages,
        thinkSupported,
        isFirstModelRequest: firstModel,
        latestRevision,
        latestScenes,
        latestChoices,
      });

      boundSessionId = result.boundSessionId;
      thinkSupported = result.thinkSupported;
      latestRevision = result.latestRevision;
      latestScenes = result.latestScenes;
      latestChoices = result.latestChoices;
      latencies.push(result.modelLatencyMs);
      turns.push(result.turn);
      firstModel = false;

      const status = result.turn.pass ? 'PASS' : 'FAIL';
      log(
        `${status} ${step.expected.label} ${result.turn.latencyMs}ms tools=[${result.turn.toolCalls.map((c) => c.name).join(', ')}]`,
      );
      if (!result.turn.pass) {
        for (const err of result.turn.errors) log(`  error: ${err}`);
      }
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    reportErrors.push(message);
    log(`fatal: ${message}`);
  } finally {
    if (harness) {
      await harness.close();
      log('closed owned client/server');
    }
  }

  const firstModelLatencyMs = latencies.length ? latencies[0]! : null;
  const subsequentLatenciesMs = latencies.slice(1);
  const passed = turns.filter((t) => t.pass).length;
  const failed = turns.length - passed;
  const ok = reportErrors.length === 0 && failed === 0 && turns.length > 0;

  return {
    timestamp: new Date().toISOString(),
    model: cli.model,
    ollamaBaseUrl: baseUrl,
    thinkSupported,
    discoveredTools,
    dataDir: harness?.dataDir ?? '',
    serverBaseUrl: harness?.baseUrl ?? '',
    mcpProtocolVersion: harness?.protocolVersion ?? null,
    turns,
    summary: {
      passed,
      failed,
      total: turns.length,
      firstModelLatencyMs,
      subsequentLatenciesMs,
      ok,
    },
    errors: reportErrors,
  };
}

async function main(): Promise<void> {
  let cli: ProbeCliOptions;
  try {
    cli = parseProbeArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  const report = await runProbe(cli);
  const outputPath = path.resolve(cli.outputPath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  log(`wrote report ${outputPath}`);
  log(
    `summary passed=${report.summary.passed}/${report.summary.total} firstLatencyMs=${report.summary.firstModelLatencyMs ?? 'n/a'}`,
  );

  if (!report.summary.ok) {
    process.exitCode = 1;
  }
}

const isDirectRun = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(entry) === path.resolve(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isDirectRun) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.stack ?? error.message : error);
    process.exitCode = 1;
  });
}

export { runProbe, startIsolatedHarness, ollamaChat, ensureOllamaAvailable };
export * from './probe-host/helpers.js';
