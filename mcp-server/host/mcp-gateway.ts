import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { assertLocalHttpUrl } from '../llm/ollama.js';
import type { OllamaTool } from '../llm/ollama.js';

export const MCP_TOOL_ALLOWLIST = new Set([
  'list_adventures', 'prepare_adventure', 'get_operation_status', 'start_session', 'get_session', 'submit_action', 'resolve_check', 'end_session',
]);
const HOST_BOUND_FIELDS = new Set(['request_id', 'session_id', 'expected_revision']);

export type DiscoveredMcpTool = {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; properties?: Record<string, object>; required?: string[]; [key: string]: unknown };
};

export function toOllamaTools(tools: DiscoveredMcpTool[]): OllamaTool[] {
  return tools.map((tool) => {
    const properties = Object.fromEntries(Object.entries(tool.inputSchema.properties ?? {}).filter(([key]) => !HOST_BOUND_FIELDS.has(key)));
    const required = (tool.inputSchema.required ?? []).filter((key) => !HOST_BOUND_FIELDS.has(key));
    const parameters: Record<string, unknown> = { ...tool.inputSchema, type: 'object', properties };
    delete parameters.required;
    if (required.length) parameters.required = required;
    return { type: 'function', function: { name: tool.name, ...(tool.description ? { description: tool.description } : {}), parameters } };
  });
}

export class McpGatewayError extends Error {
  constructor(readonly code: 'unavailable' | 'catalog' | 'call', message: string, options?: ErrorOptions) {
    super(message, options); this.name = 'McpGatewayError';
  }
}

/** Official MCP SDK client; only the canonical local v2 endpoint is accepted. */
export class McpGateway {
  readonly url: URL;
  readonly requestTimeoutMs: number;
  private client: Client | undefined;
  private transport: StreamableHTTPClientTransport | undefined;
  private toolCatalog: DiscoveredMcpTool[] | undefined;
  private connecting: Promise<void> | undefined;

  constructor(options: { url?: string; requestTimeoutMs?: number } = {}) {
    const base = assertLocalHttpUrl(options.url ?? process.env.RPG_MCP_URL ?? 'http://127.0.0.1:3000/mcp', 'RPG_MCP_URL');
    const requested = new URL(options.url ?? process.env.RPG_MCP_URL ?? 'http://127.0.0.1:3000/mcp');
    if (requested.pathname !== '/mcp' || requested.search || requested.hash) throw new Error('RPG_MCP_URL must point to the canonical /mcp endpoint.');
    this.url = new URL('/mcp', base);
    this.requestTimeoutMs = options.requestTimeoutMs ?? 12_000;
  }

  private async connect(): Promise<void> {
    if (this.client && this.toolCatalog) return;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const client = new Client({ name: 'rpg-night-host', version: '2.0.0' });
      const transport = new StreamableHTTPClientTransport(this.url);
      try {
        await client.connect(transport);
        const listed = await client.listTools({}, { timeout: this.requestTimeoutMs });
        const discovered: DiscoveredMcpTool[] = listed.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: tool.inputSchema as DiscoveredMcpTool['inputSchema'],
        }));
        if (discovered.some((tool) => !MCP_TOOL_ALLOWLIST.has(tool.name))) throw new McpGatewayError('catalog', 'The MCP endpoint exposed an unrecognized tool.');
        const names = new Set(discovered.map(({ name }) => name));
        if ([...MCP_TOOL_ALLOWLIST].some((name) => !names.has(name))) throw new McpGatewayError('catalog', 'The MCP endpoint is missing a required v2 tool.');
        this.client = client; this.transport = transport; this.toolCatalog = discovered;
      } catch (error) {
        await transport.close().catch(() => undefined);
        if (error instanceof McpGatewayError) throw error;
        throw new McpGatewayError('unavailable', 'Could not connect to the canonical MCP service.', { cause: error });
      }
    })().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  async tools(): Promise<DiscoveredMcpTool[]> {
    await this.connect();
    return this.toolCatalog!.map((tool) => ({ ...tool, inputSchema: structuredClone(tool.inputSchema) }));
  }

  async ollamaTools(): Promise<OllamaTool[]> { return toOllamaTools(await this.tools()); }

  async call(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (!MCP_TOOL_ALLOWLIST.has(name)) throw new McpGatewayError('call', 'The requested MCP tool is not allowed.');
    await this.connect();
    try {
      const result = await this.client!.callTool({ name, arguments: args }, undefined, { timeout: this.requestTimeoutMs, ...(signal ? { signal } : {}) });
      return result as Record<string, unknown>;
    } catch (error) {
      throw new McpGatewayError('call', `MCP tool ${name} failed.`, { cause: error });
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined; this.transport = undefined; this.toolCatalog = undefined;
    if (client) await client.close().catch(() => undefined);
  }
}
