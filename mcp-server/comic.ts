import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Session } from '../shared/types.js';
import type { HostPublicState } from '../shared/host-schema.js';
import { publicSceneArt, sceneArt, xml } from './art.js';
import { storyPanels } from '../shared/public-story.js';

function wrap(value: string, width: number): string[] {
  const lines: string[] = []; let line = '';
  for (const word of value.split(/\s+/).flatMap(word => word.match(new RegExp(`.{1,${width}}`, 'gu')) ?? [])) {
    if (line && `${line} ${word}`.length > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line); return lines;
}
export async function comicSvg(session: Session, dataDir: string): Promise<string> {
  const panels = await Promise.all(session.scenes.map(async scene => {
    let image: string;
    if (/^\/api\/images\/[a-f0-9-]{36}\.png$/.test(scene.imageUrl)) {
      try { image = `data:image/png;base64,${(await readFile(path.join(dataDir, 'images', path.basename(scene.imageUrl)))).toString('base64')}`; }
      catch { image = `data:image/svg+xml;base64,${Buffer.from(sceneArt(session.world, scene.number)).toString('base64')}`; }
    } else {
      const artPath = scene.imageUrl.match(/\/art\/[^/]+\/(\d+)\/(\d+)\.svg$/);
      image = `data:image/svg+xml;base64,${Buffer.from(sceneArt(session.world, Number(artPath?.[1] ?? scene.number), Number(artPath?.[2] ?? 0))).toString('base64')}`;
    }
    const titleLines = wrap(scene.title, 43);
    const actionLines = scene.action ? wrap(`${session.language === 'es' ? 'DECISIÓN' : 'CHOICE'} · ${scene.action}`, 75) : [];
    const lines = wrap(scene.narration, 78);
    return { scene, image, titleLines, actionLines, lines, height: 416 + titleLines.length * 32 + actionLines.length * 21 + lines.length * 23 + 64 };
  }));
  let y = 190; let markup = '';
  for (let i = 0; i < panels.length; i += 2) {
    const row = panels.slice(i, i + 2); const height = Math.max(...row.map(p => p.height));
    row.forEach((p, col) => {
      let textY = 432;
      markup += `<g transform="translate(${32 + col * 752} ${y})"><rect width="728" height="${height}" rx="12" fill="#14212d" stroke="#34414b"/><image x="1" y="1" width="726" height="408" preserveAspectRatio="xMidYMid slice" href="${p.image}"/><rect x="18" y="18" width="42" height="32" rx="6" fill="#0b1420"/><text x="39" y="40" text-anchor="middle" fill="#edcb89" font-family="sans-serif" font-size="18">${p.scene.number}</text>`;
      for (const line of p.titleLines) { textY += 32; markup += `<text x="24" y="${textY}" fill="#f3e9d5" font-family="Georgia,serif" font-size="28">${xml(line)}</text>`; }
      textY += 14;
      for (const line of p.actionLines) { textY += 21; markup += `<text x="24" y="${textY}" fill="#ddbc7e" font-family="sans-serif" font-size="16">${xml(line)}</text>`; }
      textY += 10;
      for (const line of p.lines) { textY += 23; markup += `<text x="24" y="${textY}" fill="#bdc8cd" font-family="sans-serif" font-size="17">${xml(line)}</text>`; }
      markup += '</g>';
    }); y += height + 28;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="1536" height="${y + 55}" viewBox="0 0 1536 ${y + 55}"><title>${xml(session.title)}</title><rect width="100%" height="100%" fill="#0b1420"/><text x="32" y="48" fill="#edcb89" font-family="sans-serif" font-size="18" letter-spacing="4">RPG NIGHT · ${session.language === 'es' ? 'VUESTRA HISTORIA' : 'YOUR STORY, TOGETHER'}</text>${wrap(session.title, 66).map((line, i) => `<text x="32" y="${99 + i * 40}" font-family="Georgia,serif" font-size="38" fill="#f3e9d5">${xml(line)}</text>`).join('')}<text x="32" y="163" font-family="sans-serif" font-size="19" fill="#9babba">${xml(session.players.join(' · '))} · ${session.provider === 'demo' ? 'Demo' : 'Amazon Bedrock'}</text>${markup}<text x="768" y="${y + 25}" text-anchor="middle" fill="#91a4b5" font-family="sans-serif" font-size="16">${session.language === 'es' ? 'Cada decisión, una historia que recordar.' : 'Every choice, a story worth keeping.'}</text></svg>`;
}

/** A host-mode comic can use only the public snapshots persisted for the shared screen. */
export function hostComicSvg(state: HostPublicState): string {
  const turns = storyPanels(state.turns);
  const cards = turns.map((turn, index) => {
    const title = state.locale === 'es' ? `Escena ${index + 1}` : `Scene ${index + 1}`;
    const narration = wrap(turn.narration, 59);
    const action = turn.recent_outcome?.kind === 'action' ? turn.recent_outcome.action_label
      : turn.recent_outcome?.kind === 'check' ? `${turn.recent_outcome.total}/20 · ${turn.recent_outcome.result === 'success' ? (state.locale === 'es' ? 'Éxito' : 'Success') : (state.locale === 'es' ? 'Contratiempo' : 'Setback')}`
        : '';
    const summary = turn.recent_outcome?.summary;
    const outcomeLines = summary && summary !== turn.narration ? wrap(summary, 59) : [];
    const actionLines = wrap(action, 59);
    const image = `data:image/svg+xml;base64,${Buffer.from(publicSceneArt(turn)).toString('base64')}`;
    let textY = 470;
    const narrativeMarkup = narration.map((line) => {
      textY += 25;
      return `<text x="32" y="${textY}" fill="#d3dde2" font-family="Georgia,serif" font-size="18">${xml(line)}</text>`;
    }).join('');
    if (actionLines.length) textY += 16;
    const actionMarkup = actionLines.map(line => {
      textY += 23;
      return `<text x="32" y="${textY}" fill="#ffe6ac" font-family="sans-serif" font-size="16">${xml(line)}</text>`;
    }).join('');
    if (outcomeLines.length) textY += 12;
    const outcomeMarkup = outcomeLines.map((line) => {
      textY += 22;
      return `<text x="32" y="${textY}" fill="#b8c6cf" font-family="sans-serif" font-size="15">${xml(line)}</text>`;
    }).join('');
    const height = textY + 65;
    const markup = `<rect width="672" height="${height}" rx="18" fill="#14212d" stroke="#34414b"/><image x="1" y="1" width="670" height="377" preserveAspectRatio="xMidYMid slice" href="${image}"/><text x="28" y="414" fill="#edcb89" font-family="sans-serif" font-size="14" letter-spacing="2">${state.locale === 'es' ? 'RPG NIGHT · HISTORIA COMPARTIDA' : 'RPG NIGHT · SHARED STORY'}</text><text x="28" y="451" fill="#f3e9d5" font-family="Georgia,serif" font-size="26">${xml(title)}</text>${narrativeMarkup}${actionMarkup}${outcomeMarkup}${turn.phase === 'ended' ? `<text x="610" y="${height - 24}" text-anchor="end" fill="#edcb89" font-family="sans-serif" font-size="15">${state.locale === 'es' ? 'FIN' : 'THE END'}</text>` : ''}`;
    return { markup, height };
  });
  let y = 190;
  let body = '';
  for (let index = 0; index < cards.length; index += 2) {
    const row = cards.slice(index, index + 2);
    for (const [column, card] of row.entries()) body += `<g transform="translate(${32 + column * 704} ${y})">${card.markup}</g>`;
    y += Math.max(...row.map(card => card.height)) + 28;
  }
  const height = y + 60;
  const title = state.locale === 'es' ? 'Vuestra historia, juntos' : 'Your story, together';
  const fallback = state.locale === 'es' ? 'La aventura todavía no ha empezado.' : 'The adventure has not started yet.';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="${height}" viewBox="0 0 1440 ${height}"><title>${xml(title)}</title><rect width="100%" height="100%" fill="#0b1420"/><text x="32" y="55" fill="#edcb89" font-family="sans-serif" font-size="16" letter-spacing="4">RPG NIGHT</text><text x="32" y="105" fill="#f3e9d5" font-family="Georgia,serif" font-size="38">${xml(title)}</text>${cards.length ? body : `<text x="32" y="180" fill="#bdc8cd" font-family="sans-serif" font-size="20">${xml(fallback)}</text>`}<text x="720" y="${height - 24}" text-anchor="middle" fill="#91a4b5" font-family="sans-serif" font-size="14">${state.locale === 'es' ? 'Cada decisión, una historia que recordar.' : 'Every choice, a story worth keeping.'}</text></svg>`;
}
