import { getHostPublicState, connectHostPublicState, hostComicSvgUrl } from './host-api.js';
import { $, clearChildren, createEl, setHidden, text } from './dom.js';
import type { HostPublicState } from '../shared/host-schema.js';

export async function initHostTv(conversationId: string): Promise<void> {
  setHidden($('landing'), true);
  setHidden($('host-panel'), true);
  setHidden($('app'), true);
  setHidden($('host-tv'), false);
  const comic = $('host-tv-comic') as HTMLAnchorElement;
  comic.href = hostComicSvgUrl(conversationId);
  $('host-tv-print').addEventListener('click', () => window.print());

  let currentRevision = -1;
  const render = (state: HostPublicState) => {
    const revision = state.turn?.revision ?? 0;
    if (revision < currentRevision) return;
    currentRevision = revision;
    const spanish = state.locale === 'es';
    document.documentElement.lang = state.locale;
    text($('host-tv-title'), spanish ? 'Vuestra historia, juntos' : 'Your story, together');
    text($('host-tv-live'), state.paused ? (spanish ? 'En pausa' : 'Paused') : (spanish ? 'En vivo' : 'Live'));
    text($('host-tv-history-title'), spanish ? 'La historia hasta ahora' : 'The story so far');
    const turn = state.turn;
    const waiting = $('host-tv-waiting');
    const scene = $('host-tv-scene');
    const narration = $('host-tv-narration');
    const check = $('host-tv-check');
    const choices = $('host-tv-choices');
    const inventory = $('host-tv-inventory');
    if (!turn) {
      text(waiting, spanish ? 'Esperando a que el grupo empiece una historia…' : 'Waiting for the group to start a story…');
      text(scene, ''); text(narration, ''); text(check, ''); text(inventory, '');
      clearChildren(choices);
      setHidden(waiting, false); setHidden(scene, true); setHidden(narration, true); setHidden(check, true);
    } else {
      setHidden(waiting, true); setHidden(scene, false); setHidden(narration, false);
      text($('host-tv-phase'), turn.phase === 'ended' ? (spanish ? 'Aventura terminada' : 'Adventure ended') : turn.phase === 'awaiting_check' ? (spanish ? 'Tirada pendiente' : 'Check pending') : state.paused ? (spanish ? 'En pausa' : 'Paused') : (spanish ? 'Partida en curso' : 'Adventure in progress'));
      text(scene, `${spanish ? 'Escena' : 'Scene'} ${state.turns.filter((entry) => entry.phase !== 'awaiting_check').length}`);
      text(narration, turn.narration);
      if (turn.pending_check) {
        text(check, `${spanish ? 'Tirada de d20' : 'Pending d20'} · ${turn.pending_check.prompt} · DC ${turn.pending_check.difficulty_class}`);
        setHidden(check, false);
      } else setHidden(check, true);
      clearChildren(choices);
      for (const choice of turn.choices) choices.append(createEl('li', { text: choice.label }));
      text(inventory, turn.inventory.length
        ? `${spanish ? 'Inventario' : 'Inventory'} · ${turn.inventory.map((item) => item.name).join(', ')}`
        : `${spanish ? 'Inventario' : 'Inventory'} · ${spanish ? 'vacío' : 'empty'}`);
    }

    const panels = $('host-tv-panels');
    clearChildren(panels);
    const played = state.turns.filter((entry) => entry.phase === 'awaiting_choice' || entry.phase === 'ended');
    for (const [index, entry] of played.entries()) {
      const panel = createEl('article', { className: 'host-tv-panel' });
      panel.append(createEl('p', { className: 'eyebrow', text: `${spanish ? 'Escena' : 'Scene'} ${index + 1}` }));
      panel.append(createEl('p', { className: 'host-tv-panel-narration', text: entry.narration }));
      if (entry.recent_outcome) {
        const outcome = entry.recent_outcome;
        const label = outcome.kind === 'action' ? outcome.action_label
          : outcome.kind === 'check' ? `${spanish ? 'Tirada' : 'Roll'} ${outcome.total}/20 · ${outcome.result}`
            : (spanish ? 'Final' : 'Ending');
        panel.append(createEl('p', { className: 'host-tv-panel-action', text: label }));
        panel.append(createEl('p', { text: outcome.summary }));
      }
      if (entry.phase === 'ended') panel.append(createEl('strong', { className: 'host-tv-ended', text: spanish ? 'FIN' : 'THE END' }));
      panels.append(panel);
    }
    comic.download = `rpg-night-${spanish ? 'historia' : 'story'}.svg`;
  };

  try {
    render(await getHostPublicState(conversationId));
    text($('host-tv-live'), document.documentElement.lang === 'es' ? 'En vivo' : 'Live');
  } catch {
    text($('host-tv-live'), 'Offline');
  }
  const stream = connectHostPublicState(conversationId, render, () => {
    text($('host-tv-live'), document.documentElement.lang === 'es' ? 'Reconectando…' : 'Reconnecting…');
  });
  window.addEventListener('beforeunload', () => stream.close(), { once: true });
}
