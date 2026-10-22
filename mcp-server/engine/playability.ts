import type { AdventureDefinition } from '../../shared/adventure-schema.js';
import type { PersistedSessionV2 } from '../../shared/session-schema.js';
import { createInitialSession, getPublicTurn, resolvePendingCheck, submitInteraction } from './core.js';

/** Exhaust the small generated graph mechanically, without model calls, storage or real dice. */
export function validateGeneratedPlayability(adventure: AdventureDefinition): string[] {
  if (adventure.nodes.length > 8) return ['nodes: generated adventures must contain at most eight nodes'];
  let sequence = 1;
  const id = () => `90000000-0000-4000-8000-${(sequence++).toString(16).padStart(12, '0')}`;
  const deps = { now: () => '2000-01-01T00:00:00.000Z', createId: id };
  const visited = new Set<string>();
  const reached = new Set<string>();
  let location = adventure.initial_node_id;
  try {
    const initial = createInitialSession(adventure, {
      sessionId: id(), requestId: id(),
      players: Array.from({ length: adventure.players.min }, (_, index) => `Test ${index + 1}`),
    }, deps);
    const pending: PersistedSessionV2[] = [initial.session];
    while (pending.length) {
      const session = pending.pop()!;
      location = session.current_node_id;
      const key = JSON.stringify([location, session.phase,
        Object.entries(session.variables).sort(([a], [b]) => a.localeCompare(b)), [...session.inventory].sort()]);
      if (visited.has(key)) continue;
      visited.add(key); reached.add(location);
      if (visited.size > 2048) return ['nodes: generated state space is too complex; simplify conditions and effects'];
      const turn = getPublicTurn(adventure, session);
      if (turn.phase === 'ended') continue;
      if (!turn.choices.length) return [`nodes.${location}: a reachable state has no usable choices`];
      for (const choice of turn.choices) {
        location = `${session.current_node_id}.${choice.id}`;
        const action = submitInteraction(adventure, session, {
          kind: 'choice', choice_id: choice.id, action_text: choice.label,
        }, { requestId: id() }, deps);
        if (action.turn.pending_check) {
          for (const roll of [1, 20]) {
            pending.push(resolvePendingCheck(adventure, action.session, {
              checkId: action.turn.pending_check.id, requestId: id(),
            }, { ...deps, rollD20: () => roll }).session);
          }
        } else pending.push(action.session);
      }
    }
    const missing = adventure.nodes.filter(node => !reached.has(node.id));
    return missing.length ? [`nodes: these nodes cannot be reached in a valid game state: ${missing.map(node => node.id).join(', ')}`] : [];
  } catch {
    return [`nodes.${location}: a reachable action or dice outcome cannot execute safely; check inventory conditions, effects and variable bounds`];
  }
}
