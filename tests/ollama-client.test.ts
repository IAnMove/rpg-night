import assert from 'node:assert/strict';
import test from 'node:test';
import { assertLocalHttpUrl, assertOllamaHttpUrl, OllamaClient } from '../mcp-server/llm/ollama.js';

// All non-loopback addresses below are synthetic test fixtures.
test('Ollama accepts configured private LAN origins while the MCP endpoint stays loopback-only', () => {
  for (const origin of ['http://127.0.0.1:11434', 'http://localhost:11434', 'http://[::1]:11434', 'http://10.20.30.40:11434', 'http://10.0.0.2:11434', 'http://172.16.0.2:11434', 'http://172.31.255.254:11434']) {
    assert.equal(assertOllamaHttpUrl(`${origin}/`), origin);
  }
  for (const origin of ['http://example.com:11434', 'http://8.8.8.8:11434', 'http://169.254.169.254', 'http://172.15.0.2', 'http://172.32.0.2', 'https://10.20.30.40', 'http://user:password@10.20.30.40', 'http://10.20.30.40/api', 'http://10.20.30.40?token=test', 'http://10.20.30.40/#fragment']) {
    assert.throws(() => assertOllamaHttpUrl(origin), /OLLAMA_BASE_URL/);
  }
  assert.throws(() => assertLocalHttpUrl('http://10.20.30.40:3000', 'RPG_MCP_URL'), /loopback/);
});

test('Ollama client can request JSON mode for generated structured content', async () => {
  let payload: Record<string, unknown> | undefined;
  const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    payload = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ message: { role: 'assistant', content: '{"ok":true}' }, done: true }), { status: 200 });
  }) as typeof fetch;
  const client = new OllamaClient({ fetcher });
  const result = await client.chat({ messages: [{ role: 'user', content: 'Return JSON.' }], format: 'json' });
  assert.equal(payload?.format, 'json');
  assert.equal(payload?.think, false, 'interactive replies should not spend the turn budget generating hidden thinking');
  assert.equal(result.content, '{"ok":true}');
});
