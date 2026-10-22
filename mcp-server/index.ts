import 'dotenv/config';
import express from 'express';
import path from 'node:path';
import { readConfig } from './config.js';
import { Game } from './game.js';
import { createApp, createConversationHost, errorHandler } from './app.js';

const config = readConfig(); const game = new Game(config); await game.init();
const host = createConversationHost(config);
const app = createApp(config, game, undefined, host);
if (process.env.NODE_ENV !== 'production' && !import.meta.url.includes('/dist/')) {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
} else {
  const webDir = path.resolve('dist/web');
  app.use(express.static(webDir));
  app.get('/', (_req, res) => res.sendFile(path.join(webDir, 'index.html')));
}
app.use(errorHandler);
const server = app.listen(config.port, config.host, () => {
  console.log(`RPG Night · ${config.provider} game · ${config.hostMode} host · http://${config.host}:${config.port}`);
  console.log(`MCP Streamable HTTP: http://${config.host}:${config.port}/mcp`);
});
server.on('error', error => { console.error(error.message); process.exitCode = 1; });
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => {
  server.close(() => { void host?.close(); });
  server.closeAllConnections();
});
