import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_TOOL_ROUNDS,
  assertLocalOllamaBaseUrl,
  assertWithinToolRoundLimit,
  canContinueToolRounds,
  evaluateTurnInvariants,
  mcpToolsToOllama,
  omitSessionIdFromSchema,
  parseProbeArgs,
  prepareToolArguments,
  sessionIdFromToolResult,
  type ExpectedIntent,
  type McpToolDef,
} from '../scripts/probe-host/helpers.js';

const sampleTools: McpToolDef[] = [
  {
    name: 'start_adventure',
    description: 'Start',
    inputSchema: {
      type: 'object',
      properties: {
        world: { type: 'string' },
        language: { type: 'string' },
        players: { type: 'array', items: { type: 'string' } },
      },
      required: ['world'],
    },
  },
  {
    name: 'get_scene',
    description: 'Read',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', format: 'uuid' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'player_action',
    description: 'Act',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string' },
        action: { type: 'string' },
        choice_id: { type: 'string' },
      },
      required: ['session_id', 'action'],
    },
  },
];

test('omitSessionIdFromSchema removes session_id from properties and required', () => {
  const schema = omitSessionIdFromSchema(sampleTools[2]!.inputSchema);
  assert.equal(schema.type, 'object');
  assert.equal('session_id' in (schema.properties ?? {}), false);
  assert.deepEqual(schema.required, ['action']);
  assert.ok(schema.properties && 'action' in schema.properties);
  assert.ok(schema.properties && 'choice_id' in schema.properties);
});

test('mcpToolsToOllama exposes native function tools without session_id', () => {
  const tools = mcpToolsToOllama(sampleTools);
  assert.equal(tools.length, 3);
  for (const tool of tools) {
    assert.equal(tool.type, 'function');
    const params = tool.function.parameters as { properties?: Record<string, unknown>; required?: string[] };
    assert.equal('session_id' in (params.properties ?? {}), false);
    assert.equal((params.required ?? []).includes('session_id'), false);
  }
  assert.equal(tools[1]!.function.name, 'get_scene');
});

test('prepareToolArguments injects bound session and rejects unbound session tools', () => {
  const bound = '11111111-1111-4111-8111-111111111111';
  const prepared = prepareToolArguments(
    'get_scene',
    { session_id: '99999999-9999-4999-8999-999999999999', extra: true },
    bound,
  );
  assert.equal(prepared.ok, true);
  if (prepared.ok) {
    assert.equal(prepared.arguments.session_id, bound);
    assert.equal(prepared.arguments.extra, true);
  }

  const refused = prepareToolArguments('roll_dice', { sides: 20 }, null);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.match(refused.error, /no host-bound session_id/);

  const start = prepareToolArguments('start_adventure', { world: 'fantasy', session_id: 'nope' }, null);
  assert.equal(start.ok, true);
  if (start.ok) {
    assert.equal('session_id' in start.arguments, false);
    assert.equal(start.arguments.world, 'fantasy');
  }
});

test('prepareToolArguments rejects non-object tool arguments', () => {
  const bad = prepareToolArguments('get_scene', ['not', 'object'], '11111111-1111-4111-8111-111111111111');
  assert.equal(bad.ok, false);
});

test('prepareToolArguments only accepts the five discovered MCP tools', () => {
  for (const name of ['start_adventure', 'get_scene', 'roll_dice', 'player_action', 'end_session']) {
    assert.equal(prepareToolArguments(name, {}, 'session').ok, true, `${name} should be allowed`);
  }
  for (const name of ['unknown', 'list_adventures', 'prepare_adventure', 'tools/call']) {
    const result = prepareToolArguments(name, {}, 'session');
    assert.equal(result.ok, false, `${name} should be rejected`);
    if (!result.ok) assert.match(result.error, /unknown tool/);
  }
});

test('tool round limit allows at most MAX_TOOL_ROUNDS rounds', () => {
  assert.equal(canContinueToolRounds(0), true);
  assert.equal(canContinueToolRounds(MAX_TOOL_ROUNDS - 1), true);
  assert.equal(canContinueToolRounds(MAX_TOOL_ROUNDS), false);
  assert.doesNotThrow(() => assertWithinToolRoundLimit(0));
  assert.throws(() => assertWithinToolRoundLimit(MAX_TOOL_ROUNDS), /Tool round limit exceeded/);
  assert.throws(() => canContinueToolRounds(-1), /non-negative/);
});

test('assertLocalOllamaBaseUrl allows only loopback and normalizes origin', () => {
  assert.equal(assertLocalOllamaBaseUrl('http://127.0.0.1:11434'), 'http://127.0.0.1:11434');
  assert.equal(assertLocalOllamaBaseUrl('http://localhost:11434/'), 'http://localhost:11434');
  assert.throws(() => assertLocalOllamaBaseUrl('http://example.com:11434'), /local Ollama/);
  assert.throws(() => assertLocalOllamaBaseUrl('https://evil.example'), /local Ollama/);
  assert.throws(() => assertLocalOllamaBaseUrl('not-a-url'), /Invalid/);
});

test('sessionIdFromToolResult only reads structuredContent.session.id', () => {
  assert.equal(
    sessionIdFromToolResult({
      structuredContent: { session: { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } },
    }),
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  );
  assert.equal(sessionIdFromToolResult({ structuredContent: { session: { revision: 1 } } }), null);
  assert.equal(sessionIdFromToolResult({ content: [{ type: 'text', text: 'nope' }] }), null);
});

test('start invariants require one successful matching start and no other mutation', () => {
  const expected: ExpectedIntent = {
    kind: 'start_adventure', label: 'start', world: 'fantasy', language: 'en', players: ['Mira', 'Leo'],
  };
  const valid = evaluateTurnInvariants({
    expected,
    toolCalls: [{ name: 'start_adventure', arguments: { world: 'fantasy', language: 'en', players: ['Mira', 'Leo'] } }],
    revisionBefore: null, revisionAfter: 1, scenesBefore: null, scenesAfter: 1, boundSessionId: 's1',
  });
  assert.equal(valid.pass, true);

  const wrongArgs = evaluateTurnInvariants({
    expected,
    toolCalls: [{ name: 'start_adventure', arguments: { world: 'space', language: 'en', players: ['Mira', 'Leo'] } }],
    revisionBefore: null, revisionAfter: 1, scenesBefore: null, scenesAfter: 1, boundSessionId: 's1',
  });
  assert.equal(wrongArgs.pass, false);
  assert.ok(wrongArgs.failures.some((f) => /world/.test(f)));

  const multipleStarts = evaluateTurnInvariants({
    expected,
    toolCalls: [
      { name: 'start_adventure', arguments: { world: 'fantasy', language: 'en', players: ['Mira', 'Leo'] } },
      { name: 'start_adventure', arguments: { world: 'fantasy', language: 'en', players: ['Mira', 'Leo'] } },
    ],
    revisionBefore: null, revisionAfter: 2, scenesBefore: null, scenesAfter: 2, boundSessionId: 's1',
  });
  assert.equal(multipleStarts.pass, false);
  assert.ok(multipleStarts.failures.some((f) => /exactly one successful/.test(f)));

  const extraMutation = evaluateTurnInvariants({
    expected,
    toolCalls: [
      { name: 'start_adventure', arguments: { world: 'fantasy', language: 'en', players: ['Mira', 'Leo'] } },
      { name: 'end_session', arguments: {} },
    ],
    revisionBefore: null, revisionAfter: 2, scenesBefore: null, scenesAfter: 1, boundSessionId: 's1',
  });
  assert.equal(extraMutation.pass, false);
  assert.ok(extraMutation.failures.some((f) => /besides start_adventure/.test(f)));
});

test('read invariants require successful get_scene and no mutation', () => {
  const expected: ExpectedIntent = { kind: 'get_scene', label: 'inventory', requireNoRevisionChange: true };
  const valid = evaluateTurnInvariants({
    expected, toolCalls: [{ name: 'get_scene', arguments: { session_id: 'x' } }],
    revisionBefore: 2, revisionAfter: 2, scenesBefore: 1, scenesAfter: 1, boundSessionId: 'x',
  });
  assert.equal(valid.pass, true);

  const errorOnly = evaluateTurnInvariants({
    expected, toolCalls: [{ name: 'get_scene', arguments: {}, isError: true }],
    revisionBefore: 2, revisionAfter: 2, scenesBefore: 1, scenesAfter: 1, boundSessionId: 'x',
  });
  assert.equal(errorOnly.pass, false);
  assert.ok(errorOnly.failures.some((f) => /returned an error/.test(f)));
  assert.ok(errorOnly.failures.some((f) => /get_scene did not succeed/.test(f)));

  const mutated = evaluateTurnInvariants({
    expected,
    toolCalls: [
      { name: 'get_scene', arguments: {} },
      { name: 'player_action', arguments: { action: 'go' } },
    ],
    revisionBefore: 2, revisionAfter: 3, scenesBefore: 1, scenesAfter: 2, boundSessionId: 'x',
  });
  assert.equal(mutated.pass, false);
  assert.ok(mutated.failures.some((f) => /Unexpected mutating/.test(f)));
  assert.ok(mutated.failures.some((f) => /revision advance/.test(f)));
});

test('dice invariants require one plain d20, revision +1, and no new scene', () => {
  const expected: ExpectedIntent = { kind: 'roll_dice', label: 'd20' };
  const valid = evaluateTurnInvariants({
    expected, toolCalls: [{ name: 'roll_dice', arguments: { session_id: 's', sides: 20 } }],
    revisionBefore: 3, revisionAfter: 4, scenesBefore: 1, scenesAfter: 1, boundSessionId: 's',
  });
  assert.equal(valid.pass, true);

  const wrongDice = evaluateTurnInvariants({
    expected, toolCalls: [{ name: 'roll_dice', arguments: { sides: 12, count: 2, modifier: 1 } }],
    revisionBefore: 3, revisionAfter: 3, scenesBefore: 1, scenesAfter: 2, boundSessionId: 's',
  });
  assert.equal(wrongDice.pass, false);
  assert.ok(wrongDice.failures.some((f) => /sides must be 20/.test(f)));
  assert.ok(wrongDice.failures.some((f) => /count must be omitted or 1/.test(f)));
  assert.ok(wrongDice.failures.some((f) => /modifier must be omitted or 0/.test(f)));
  assert.ok(wrongDice.failures.some((f) => /revision advance/.test(f)));
  assert.ok(wrongDice.failures.some((f) => /must not add a scene/.test(f)));

  const duplicate = evaluateTurnInvariants({
    expected, toolCalls: [
      { name: 'roll_dice', arguments: { sides: 20 } },
      { name: 'roll_dice', arguments: { sides: 20 } },
    ], revisionBefore: 3, revisionAfter: 5, scenesBefore: 1, scenesAfter: 1, boundSessionId: 's',
  });
  assert.equal(duplicate.pass, false);
  assert.ok(duplicate.failures.some((f) => /exactly one successful/.test(f)));
});

test('choice invariants require exactly one correct choice and one state advance', () => {
  const expected: ExpectedIntent = { kind: 'player_action', label: 'choose_two', choiceId: 'choice-2' };
  const valid = evaluateTurnInvariants({
    expected, toolCalls: [{ name: 'player_action', arguments: { action: 'two', choice_id: 'choice-2' } }],
    revisionBefore: 1, revisionAfter: 2, scenesBefore: 1, scenesAfter: 2, boundSessionId: 's',
  });
  assert.equal(valid.pass, true);

  const wrongChoice = evaluateTurnInvariants({
    expected, toolCalls: [{ name: 'player_action', arguments: { action: 'two', choice_id: 'choice-1' } }],
    revisionBefore: 1, revisionAfter: 2, scenesBefore: 1, scenesAfter: 2, boundSessionId: 's',
  });
  assert.equal(wrongChoice.pass, false);
  assert.ok(wrongChoice.failures.some((f) => /choice_id did not match/.test(f)));

  const noAdvance = evaluateTurnInvariants({
    expected, toolCalls: [{ name: 'player_action', arguments: { action: 'two', choice_id: 'choice-2' } }],
    revisionBefore: 1, revisionAfter: 1, scenesBefore: 1, scenesAfter: 1, boundSessionId: 's',
  });
  assert.equal(noAdvance.pass, false);
  assert.ok(noAdvance.failures.some((f) => /one revision advance/.test(f)));
  assert.ok(noAdvance.failures.some((f) => /exactly one scene advance/.test(f)));
});

test('any tool error or unexpected successful intent fails every scenario', () => {
  const expected: ExpectedIntent = { kind: 'get_scene', label: 'read', requireNoRevisionChange: true };
  const erroredAlongsideSuccess = evaluateTurnInvariants({
    expected,
    toolCalls: [
      { name: 'get_scene', arguments: {}, isError: true },
      { name: 'get_scene', arguments: {} },
    ],
    revisionBefore: 1, revisionAfter: 1, scenesBefore: 1, scenesAfter: 1, boundSessionId: 's',
  });
  assert.equal(erroredAlongsideSuccess.pass, false);

  const unknownTool = evaluateTurnInvariants({
    expected, toolCalls: [{ name: 'future_mutation', arguments: {} }],
    revisionBefore: 1, revisionAfter: 1, scenesBefore: 1, scenesAfter: 1, boundSessionId: 's',
  });
  assert.equal(unknownTool.pass, false);
  assert.ok(unknownTool.failures.some((f) => /unknown tool/.test(f)));
});

test('parseProbeArgs reads flags and rejects remote base URLs', () => {
  const opts = parseProbeArgs(['--quick', '--timeout-ms', '12000', '--output', 'out.json'], {
    OLLAMA_MODEL: 'qwen3:4b-instruct-2507-q4_K_M',
    OLLAMA_BASE_URL: 'http://127.0.0.1:11434',
  });
  assert.equal(opts.quick, true);
  assert.equal(opts.timeoutMs, 12000);
  assert.equal(opts.outputPath, 'out.json');
  assert.equal(opts.model, 'qwen3:4b-instruct-2507-q4_K_M');

  assert.throws(
    () => parseProbeArgs(['--base-url', 'http://8.8.8.8:11434'], {}),
    /local Ollama/,
  );
  assert.throws(() => parseProbeArgs(['--timeout-ms', '10'], {}), />= 1000/);
});
