import test from 'node:test';
import assert from 'node:assert/strict';
import adventureEn from '../adventures/elderglen.en.json' with { type: 'json' };
import adventureEs from '../adventures/elderglen.es.json' with { type: 'json' };
import {
  createInitialSession,
  getPublicTurn,
  resolvePendingCheck,
  submitInteraction,
} from '../mcp-server/engine/core.js';
import type { AdventureDefinition } from '../shared/adventure-schema.js';
import type { PersistedSessionV2 } from '../shared/session-schema.js';

const uuid = (counter: number) => '90000000-0000-4000-8000-' + counter.toString(16).padStart(12, '0');

for (const adventure of [adventureEn, adventureEs] as AdventureDefinition[]) {
  test(`${adventure.locale} reference adventure has executable routes through every reachable state`, () => {
    let sequence = 1;
    const nextRequest = () => uuid(sequence++);
    const { session: initial } = createInitialSession(adventure, {
      sessionId: uuid(999), requestId: nextRequest(), players: ['Mira', 'Leo'],
    });
    const pending: PersistedSessionV2[] = [initial];
    const visited = new Set<string>();
    const reached = new Set<string>();
    const endings = new Set<string>();

    while (pending.length) {
      const session = pending.shift()!;
      const stateKey = [session.current_node_id, session.phase, session.variables.trust, session.variables['lantern-lit'], ...[...session.inventory].sort()].join('|');
      if (visited.has(stateKey)) continue;
      visited.add(stateKey);
      reached.add(session.current_node_id);
      const turn = getPublicTurn(adventure, session);
      if (session.phase === 'ended') {
        assert.equal(adventure.nodes.find((node) => node.id === session.current_node_id)?.kind, 'ending');
        endings.add(session.current_node_id);
        continue;
      }
      assert.equal(session.phase, 'awaiting_choice');
      assert.ok(turn.choices.length >= 1, `${adventure.locale}:${turn.scene_id} has at least one usable action`);
      for (const choice of turn.choices) {
        const action = submitInteraction(adventure, session, {
          kind: 'choice', choice_id: choice.id, action_text: choice.label,
        }, { requestId: nextRequest() });
        if (action.session.phase === 'awaiting_check') {
          for (const roll of [1, 20]) {
            const resolved = resolvePendingCheck(adventure, action.session, {
              checkId: action.turn.pending_check!.id, requestId: nextRequest(),
            }, { rollD20: () => roll });
            pending.push(resolved.session);
          }
        } else {
          pending.push(action.session);
        }
      }
    }

    const sceneIds = adventure.nodes.map((node) => node.id);
    assert.deepEqual([...reached].sort(), [...sceneIds].sort(), 'all authored nodes are reachable in a valid state');
    assert.equal(endings.size, 2, 'both authored endings remain reachable');
  });
}
