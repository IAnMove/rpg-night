import type { PublicTurn } from './session-schema.js';

/** Queries, pending dice and an explicit early stop do not create another story scene. */
export function storyPanels(turns: PublicTurn[]): PublicTurn[] {
  const panels: PublicTurn[] = [];
  for (const turn of turns) {
    if (turn.phase !== 'awaiting_choice' && turn.phase !== 'ended') continue;
    if (panels.at(-1)?.scene_id === turn.scene_id) panels[panels.length - 1] = turn;
    else panels.push(turn);
  }
  return panels;
}
