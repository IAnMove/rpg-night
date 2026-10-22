import assert from 'node:assert/strict';
import test from 'node:test';
import { OllamaClient } from '../mcp-server/llm/ollama.js';

test('Ollama client can request JSON mode for generated structured content', async () => {
  let payload: Record<string, unknown> | undefined;
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ message: { role: 'assistant', content: '{"ok":true}' }, done: true }), { status: 200 });
  }) as typeof fetch;
  const client = new OllamaClient({ fetcher });
  const result = await client.chat({ messages: [{ role: 'user', content: 'Return JSON.' }], format: 'json' });
  assert.equal(payload?.format, 'json');
  assert.equal(result.content, '{"ok":true}');
});
