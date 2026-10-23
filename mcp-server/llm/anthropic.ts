import { OllamaClient, OllamaError, OllamaMessage, OllamaTool, OllamaTurn } from './ollama.js';

export const DEFAULT_ANTHROPIC_MODEL = 'claude-sonnet-5-5';

/** Drop-in replacement for OllamaClient.chat() that uses the Anthropic Messages API. */
export class AnthropicClient extends OllamaClient {
  private readonly apiKey: string;
  private readonly anthropicModel: string;
  constructor(options: { model?: string; apiKey?: string } = {}) {
    super({ timeoutMs: 60_000, model: options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL });
    this.apiKey = options.apiKey ?? process.env.ANTHROPIC_API_KEY ?? '';
    this.anthropicModel = options.model ?? process.env.ANTHROPIC_MODEL ?? DEFAULT_ANTHROPIC_MODEL;
    if (!this.apiKey) throw new Error('ANTHROPIC_API_KEY is required for HOST_MODE=anthropic.');
  }

  override async chat(input: { messages: OllamaMessage[]; tools?: OllamaTool[]; signal?: AbortSignal }): Promise<OllamaTurn> {
    const started = Date.now();
    const system = input.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
    const turns: Array<{ role: 'user' | 'assistant'; content: string }> = [];
    for (const m of input.messages) {
      if (m.role === 'system') continue;
      const role = m.role === 'assistant' ? 'assistant' : 'user';
      const content = m.role === 'tool' ? `[Result of tool ${m.tool_name ?? 'unknown'}]\n${m.content}` : m.content;
      const last = turns.at(-1);
      if (last && last.role === role) last.content += `\n\n${content}`;
      else turns.push({ role, content });
    }
    if (turns[0]?.role !== 'user') turns.unshift({ role: 'user', content: '(start)' });
    const tools = (input.tools ?? []).map((t) => ({ name: t.function.name, description: t.function.description ?? '', input_schema: t.function.parameters }));
    let response: Response;
    try {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST', signal: input.signal ?? AbortSignal.timeout(this.timeoutMs),
        headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: this.anthropicModel, max_tokens: 1024, system, messages: turns, ...(tools.length ? { tools } : {}) }),
      });
    } catch (error) {
      const timeout = error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
      throw new OllamaError(timeout ? 'timeout' : 'unavailable', timeout ? 'Anthropic request timed out.' : 'Anthropic is unavailable.', { cause: error });
    }
    if (!response.ok) throw new OllamaError('http', `Anthropic returned HTTP ${response.status}.`);
    const data = await response.json() as { content?: Array<{ type: string; text?: string; name?: string; input?: unknown }>; usage?: { input_tokens?: number; output_tokens?: number } };
    const blocks = data.content ?? [];
    return {
      content: blocks.filter((b) => b.type === 'text').map((b) => b.text ?? '').join(''),
      tool_calls: blocks.filter((b) => b.type === 'tool_use').map((b) => ({ name: b.name ?? '', arguments: b.input ?? {} })),
      elapsed_ms: Date.now() - started,
      ...(data.usage?.input_tokens === undefined ? {} : { prompt_tokens: data.usage.input_tokens }),
      ...(data.usage?.output_tokens === undefined ? {} : { output_tokens: data.usage.output_tokens }),
    };
  }
}
