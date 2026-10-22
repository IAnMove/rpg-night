import express from 'express';
import type { ErrorRequestHandler } from 'express';
import path from 'node:path';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ZodError } from 'zod';
import type { Config } from './config.js';
import { actionSchema, diceSchema, Game, GameError, startSchema } from './game.js';
import { sceneArt } from './art.js';
import { comicSvg, hostComicSvg } from './comic.js';
import { createMcpServer } from './mcp.js';
import { createMcpV2Server } from './mcp-v2.js';
import { AdventureService } from './engine/service.js';
import { OllamaAdventureGenerationProvider } from './generation/ollama-provider.js';
import { ConversationIdSchema } from '../shared/host-schema.js';
import { ConversationHost } from './host/service.js';
import { McpGateway } from './host/mcp-gateway.js';
import { OllamaClient } from './llm/ollama.js';

export type HostController = Pick<ConversationHost, 'createConversation' | 'turn' | 'pause' | 'resume' | 'getPendingOperation'>
  & Partial<Pick<ConversationHost, 'getPublicState' | 'subscribePublicState'>>;

export function createConversationHost(config: Config): ConversationHost | undefined {
  if (config.hostMode === 'disabled') return undefined;
  return new ConversationHost({
    dataDir: config.dataDir,
    ollama: new OllamaClient({ baseUrl: config.ollamaBaseUrl, model: config.ollamaModel }),
    mcp: new McpGateway({ url: config.mcpUrl }),
  });
}

export function createAdventureService(config: Config): AdventureService {
  return new AdventureService({
    dataDir: config.dataDir,
    generationProvider: new OllamaAdventureGenerationProvider({ baseUrl: config.ollamaBaseUrl, model: config.ollamaModel, timeoutMs: config.ollamaGenerationTimeoutMs }),
    generationTrace: (event) => console.info('[rpg-generation]', JSON.stringify(event)),
  });
}

export function createApp(
  config: Config,
  game: Game,
  service = createAdventureService(config),
  hostOverride?: HostController | null,
) {
  const host = hostOverride === undefined ? createConversationHost(config) : hostOverride ?? undefined;
  const app = express(); app.disable('x-powered-by');
  app.use((req, res, next) => {
    // Local defaults defend the demo against DNS rebinding and cross-origin writes.
    const allowed = ['localhost', '127.0.0.1', '[::1]', config.host];
    if (config.publicOrigin) allowed.push(new URL(config.publicOrigin).hostname);
    if (!allowed.includes(req.hostname)) { res.status(403).json({ error: 'Host not allowed. Set PUBLIC_ORIGIN for your deployment.' }); return; }
    const origin = req.get('origin');
    if (origin && origin !== config.publicOrigin && origin !== `http://${req.get('host')}` && origin !== `https://${req.get('host')}`) { res.status(403).json({ error: 'Cross-origin request denied' }); return; }
    res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
    if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '24kb' }));
  app.get('/api/health', (_req, res) => res.json({ status: 'ok', version: config.version, provider: config.provider, host_mode: config.hostMode }));
  app.get('/api/config', (_req, res) => res.json({ version: config.version, provider: config.provider, hostMode: config.hostMode, ollamaModel: config.hostMode === 'ollama' ? config.ollamaModel : undefined, maxScenes: config.maxScenes }));
  const unavailableHost = (_req: express.Request, res: express.Response) => res.status(503).json({ error: 'The conversational host is disabled.' });
  app.post('/api/host/conversations', host ? async (req, res) => {
    const response = await host.createConversation(req.body);
    res.status(response.kind === 'error' ? 200 : 201).json(response);
  } : unavailableHost);
  app.post('/api/host/conversations/:conversation_id/turns', host ? async (req, res) => {
    const id = ConversationIdSchema.safeParse(req.params.conversation_id);
    if (!id.success) { res.status(400).json({ error: 'Invalid conversation ID.' }); return; }
    const controller = new AbortController();
    res.on('close', () => { if (!res.writableEnded) controller.abort(); });
    res.json(await host.turn(id.data, req.body, controller.signal));
  } : unavailableHost);
  app.post('/api/host/conversations/:conversation_id/pause', host ? async (req, res) => {
    const id = ConversationIdSchema.safeParse(req.params.conversation_id);
    if (!id.success) { res.status(400).json({ error: 'Invalid conversation ID.' }); return; }
    res.json(await host.pause(id.data, req.body));
  } : unavailableHost);
  app.post('/api/host/conversations/:conversation_id/resume', host ? async (req, res) => {
    const id = ConversationIdSchema.safeParse(req.params.conversation_id);
    if (!id.success) { res.status(400).json({ error: 'Invalid conversation ID.' }); return; }
    res.json(await host.resume(id.data, req.body));
  } : unavailableHost);
  app.get('/api/host/conversations/:conversation_id/operation', host ? async (req, res) => {
    const id = ConversationIdSchema.safeParse(req.params.conversation_id);
    if (!id.success) { res.status(400).json({ error: 'Invalid conversation ID.' }); return; }
    res.json(await host.getPendingOperation(id.data));
  } : unavailableHost);
  app.get('/api/host/conversations/:conversation_id/tv', host?.getPublicState ? async (req, res) => {
    const id = ConversationIdSchema.safeParse(req.params.conversation_id);
    if (!id.success) { res.status(400).json({ error: 'Invalid conversation ID.' }); return; }
    const state = await host.getPublicState!(id.data);
    if (!state) { res.status(404).json({ error: 'Conversation not found.' }); return; }
    res.json(state);
  } : unavailableHost);
  let hostTvConnections = 0;
  app.get('/api/host/conversations/:conversation_id/events', host?.getPublicState && host.subscribePublicState ? async (req, res) => {
    const id = ConversationIdSchema.safeParse(req.params.conversation_id);
    if (!id.success) { res.status(400).json({ error: 'Invalid conversation ID.' }); return; }
    const initial = await host.getPublicState!(id.data);
    if (!initial) { res.status(404).json({ error: 'Conversation not found.' }); return; }
    if (hostTvConnections >= 100) { res.status(429).json({ error: 'Too many shared-screen connections.' }); return; }
    hostTvConnections++;
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = (state: unknown) => { if (!res.writableEnded) res.write(`event: public-state\ndata: ${JSON.stringify(state)}\n\n`); };
    const unsubscribe = host.subscribePublicState!(id.data, send);
    res.on('close', () => { clearInterval(heartbeat); unsubscribe(); hostTvConnections--; });
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20000); heartbeat.unref();
    send(await host.getPublicState!(id.data));
  } : unavailableHost);
  app.get('/api/host/conversations/:conversation_id/comic.svg', host?.getPublicState ? async (req, res) => {
    const id = ConversationIdSchema.safeParse(req.params.conversation_id);
    if (!id.success) { res.status(400).json({ error: 'Invalid conversation ID.' }); return; }
    const state = await host.getPublicState!(id.data);
    if (!state) { res.status(404).json({ error: 'Conversation not found.' }); return; }
    res.type('image/svg+xml').set('Content-Disposition', 'attachment; filename="rpg-night-shared-story.svg"').send(hostComicSvg(state));
  } : unavailableHost);
  app.post('/api/sessions', async (req, res) => res.status(201).json(await game.start(startSchema.parse(req.body))));
  app.get('/api/sessions/:id', (req, res) => res.json(game.get(req.params.id)));
  app.post('/api/sessions/:id/actions', async (req, res) => res.json(await game.action(req.params.id, actionSchema.parse(req.body))));
  app.post('/api/sessions/:id/dice', async (req, res) => res.json(await game.dice(req.params.id, diceSchema.parse(req.body))));
  app.post('/api/sessions/:id/end', async (req, res) => res.json(await game.end(req.params.id)));
  let connections = 0;
  app.get('/api/sessions/:id/events', (req, res) => {
    const session = game.get(req.params.id);
    if (connections >= 100 || game.events.listenerCount(session.id) >= 12) { res.status(429).json({ error: 'Too many TV connections' }); return; }
    connections++;
    res.status(200).set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' }); res.flushHeaders();
    const update = (value: unknown) => res.write(`event: session\ndata: ${JSON.stringify(value)}\n\n`);
    update(session); game.events.on(session.id, update);
    const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 20000); heartbeat.unref();
    res.on('close', () => { clearInterval(heartbeat); game.events.off(session.id, update); connections--; });
  });
  app.get('/api/sessions/:id/comic.svg', async (req, res) => {
    const session = game.get(req.params.id);
    res.type('image/svg+xml').set('Content-Disposition', `attachment; filename="rpg-night-${session.world}.svg"`).send(await comicSvg(session, config.dataDir));
  });
  app.get('/api/preview/:world', (req, res) => {
    const world = req.params.world.replace(/\.svg$/, '');
    if (!['fantasy', 'space', 'mystery'].includes(world)) throw new GameError('Unknown world', 404);
    res.type('image/svg+xml').send(sceneArt(world as 'fantasy' | 'space' | 'mystery'));
  });
  app.get('/api/art/:world/:chapter/:variant', (req, res) => {
    const { world, chapter, variant } = req.params;
    if (!['fantasy', 'space', 'mystery'].includes(world) || !/^[1-8]$/.test(chapter) || !/^[0-2]\.svg$/.test(variant)) throw new GameError('Illustration not found', 404);
    res.type('image/svg+xml').send(sceneArt(world as 'fantasy' | 'space' | 'mystery', Number(chapter), parseInt(variant)));
  });
  app.get('/api/images/:file', (req, res, next) => {
    if (!/^[a-f0-9-]{36}\.png$/.test(req.params.file)) throw new GameError('Image not found', 404);
    res.sendFile(path.join(config.dataDir, 'images', req.params.file), error => { if (error) next(new GameError('Image not found', 404)); });
  });
  const mcpEndpoint = (createServer: () => ReturnType<typeof createMcpServer>) => async (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch (error) { if (!res.headersSent) next(error); }
  };
  app.post('/mcp', mcpEndpoint(() => createMcpV2Server(service)));
  app.all('/mcp', (_req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'This stateless MCP endpoint accepts POST requests.' }, id: null }));
  app.post('/mcp/legacy', mcpEndpoint(() => createMcpServer(game)));
  app.all('/mcp/legacy', (_req, res) => res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', error: { code: -32000, message: 'This stateless MCP endpoint accepts POST requests.' }, id: null }));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API endpoint not found' }));
  return app;
}
export const errorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
  if (res.headersSent) return;
  if (error instanceof ZodError) { res.status(400).json({ error: error.issues.map(i => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ') }); return; }
  if (error instanceof GameError) { res.status(error.status).json({ error: error.message }); return; }
  if (error instanceof SyntaxError && 'body' in error) { res.status(400).json({ error: 'Invalid JSON body' }); return; }
  if (error?.type === 'entity.too.large') { res.status(413).json({ error: 'Request body too large' }); return; }
  console.error('Request failed:', error instanceof Error ? error.message : 'Unknown error');
  res.status(500).json({ error: 'The adventure could not be saved. Please try again.' });
};
