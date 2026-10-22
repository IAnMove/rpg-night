import assert from 'node:assert/strict';
import test from 'node:test';
import express from 'express';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AdventureService } from '../mcp-server/engine/service.js';
import { createMcpV2Server } from '../mcp-server/mcp-v2.js';
import { McpGateway, MCP_TOOL_ALLOWLIST } from '../mcp-server/host/mcp-gateway.js';

test('host MCP gateway discovers canonical v2 tools and calls the actual game service over Streamable HTTP', async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rpg-night-host-mcp-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const app = express(); app.use(express.json());
  app.post('/mcp', async (req, res) => {
    const server = createMcpV2Server(new AdventureService({ dataDir: dir }));
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });
  const http = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => http.once('listening', resolve));
  t.after(async () => { http.closeAllConnections(); await new Promise<void>((resolve) => http.close(() => resolve())); });
  const address = http.address(); if (!address || typeof address === 'string') throw new Error('No test server');
  const gateway = new McpGateway({ url: `http://127.0.0.1:${address.port}/mcp` });
  t.after(() => gateway.close());

  const tools = await gateway.tools();
  assert.deepEqual(new Set(tools.map(({ name }) => name)), MCP_TOOL_ALLOWLIST);
  const listed = await gateway.call('list_adventures', { locale: 'en' });
  assert.ok(Array.isArray((listed.structuredContent as { adventures: unknown[] }).adventures));
  const started = await gateway.call('start_session', {
    request_id: '55555555-5555-4555-8555-555555555555', adventure_id: 'elderglen', locale: 'en', players: ['Lee'],
  });
  assert.equal((started.structuredContent as { session_id: string }).session_id, '55555555-5555-4555-8555-555555555555');
  const read = await gateway.call('get_session', { session_id: '55555555-5555-4555-8555-555555555555' });
  assert.equal((read.structuredContent as { revision: number }).revision, 1);
  assert.equal(JSON.stringify(read.structuredContent).includes('jammed lantern mechanism'), false);
});
