import { z } from 'zod';

export const DEFAULT_OLLAMA_URL = 'http://127.0.0.1:11434';
export const DEFAULT_OLLAMA_MODEL = 'qwen3:4b-instruct-2507-q4_K_M';
export const OLLAMA_TIMEOUT_MS = 45_000;

const ToolCallSchema = z.object({ function: z.object({ name: z.string().min(1), arguments: z.unknown() }).passthrough() }).passthrough();
const ChatResponseSchema = z.object({
  message: z.object({ role: z.literal('assistant'), content: z.string(), tool_calls: z.array(ToolCallSchema).optional() }).passthrough(),
  done: z.boolean().optional(), prompt_eval_count: z.number().optional(), eval_count: z.number().optional(),
}).passthrough();
export type OllamaMessage = { role: 'system' | 'user' | 'assistant' | 'tool'; content: string; tool_name?: string };
export type OllamaTool = { type: 'function'; function: { name: string; description?: string; parameters: Record<string, unknown> } };
export type OllamaTurn = { content: string; tool_calls: Array<{ name: string; arguments: unknown }>; elapsed_ms: number; prompt_tokens?: number; output_tokens?: number };

export class OllamaError extends Error {
  constructor(readonly code: 'unavailable' | 'http' | 'invalid_response' | 'timeout', message: string, options?: ErrorOptions) {
    super(message, options); this.name = 'OllamaError';
  }
}

export function assertLocalHttpUrl(raw: string, label: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${label} must be a valid URL.`); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(host)) {
    throw new Error(`${label} must use HTTP on a loopback host.`);
  }
  return url.origin;
}

export class OllamaClient {
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs: number;
  private readonly fetcher: typeof fetch;

  constructor(options: { baseUrl?: string; model?: string; timeoutMs?: number; fetcher?: typeof fetch } = {}) {
    this.baseUrl = assertLocalHttpUrl(options.baseUrl ?? process.env.OLLAMA_BASE_URL ?? DEFAULT_OLLAMA_URL, 'OLLAMA_BASE_URL');
    this.model = options.model ?? process.env.OLLAMA_MODEL ?? DEFAULT_OLLAMA_MODEL;
    this.timeoutMs = options.timeoutMs ?? OLLAMA_TIMEOUT_MS;
    this.fetcher = options.fetcher ?? fetch;
  }

  async chat(input: { messages: OllamaMessage[]; tools?: OllamaTool[]; format?: 'json' | Record<string, unknown>; signal?: AbortSignal }): Promise<OllamaTurn> {
    const started = Date.now();
    const signal = input.signal ?? AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}/api/chat`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, signal,
        body: JSON.stringify({ model: this.model, stream: false, messages: input.messages, ...(input.tools ? { tools: input.tools } : {}), ...(input.format ? { format: input.format } : {}) }),
      });
    } catch (error) {
      const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new OllamaError(timeout ? 'timeout' : 'unavailable', timeout ? 'Ollama request timed out.' : 'Ollama is unavailable.', { cause: error });
    }
    if (!response.ok) throw new OllamaError('http', `Ollama returned HTTP ${response.status}.`);
    let raw: unknown;
    try { raw = await response.json(); } catch (error) { throw new OllamaError('invalid_response', 'Ollama returned invalid JSON.', { cause: error }); }
    const parsed = ChatResponseSchema.safeParse(raw);
    if (!parsed.success) throw new OllamaError('invalid_response', 'Ollama returned an unexpected chat response.');
    return {
      content: parsed.data.message.content,
      tool_calls: (parsed.data.message.tool_calls ?? []).map((call) => ({ name: call.function.name, arguments: call.function.arguments })),
      elapsed_ms: Date.now() - started,
      ...(parsed.data.prompt_eval_count === undefined ? {} : { prompt_tokens: parsed.data.prompt_eval_count }),
      ...(parsed.data.eval_count === undefined ? {} : { output_tokens: parsed.data.eval_count }),
    };
  }
}
