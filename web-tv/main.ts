import type { AppConfig, Language, Session, World } from '../shared/types.js';
import {
  ApiError,
  comicSvgUrl,
  connectSessionEvents,
  createSession,
  getConfig,
  getSession,
  postAction,
  postDice,
  postEnd,
  previewUrl,
} from './api.js';
import { exportComicPng, downloadBlob } from './comic-export.js';
import { $, clearChildren, createEl, setHidden, text } from './dom.js';
import { applyStaticI18n, t, type MsgKey } from './i18n.js';
import { initHostPanel } from './host-panel.js';
import { initHostTv } from './host-tv.js';
import {
  createMic,
  createTts,
  speechRecognitionSupported,
  speechSynthesisSupported,
  type MicController,
} from './speech.js';

const STORAGE_KEY = 'rpg-night.sessionId';
const LANG_KEY = 'rpg-night.language';

type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'offline';

const state = {
  lang: (localStorage.getItem(LANG_KEY) === 'es' ? 'es' : 'en') as Language,
  config: null as AppConfig | null,
  session: null as Session | null,
  world: 'fantasy' as World,
  sceneIndex: 0,
  tab: 'story' as 'story' | 'comic',
  busy: false,
  sse: null as { close: () => void } | null,
};

const tts = createTts();
let mic: MicController | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function msg(key: MsgKey, vars?: Record<string, string | number>): string {
  return t(state.lang, key, vars);
}

function showToast(message: string, kind: 'info' | 'error' = 'info'): void {
  const el = $('toast');
  text(el, message);
  el.dataset.kind = kind;
  setHidden(el, false);
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => setHidden(el, true), 4200);
}

function setBusy(on: boolean, label?: string): void {
  state.busy = on;
  document.body.classList.toggle('is-busy', on);
  const busy = $('busy');
  setHidden(busy, !on);
  busy.setAttribute('aria-hidden', on ? 'false' : 'true');
  if (label) text($('busy-label'), label);
  if (!on) refreshActionLocks();
}

function apiMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.message === 'NETWORK') return msg('networkError');
    if (err.status === 404) return msg('sessionMissing');
    if (err.status === 409) return msg('stateChanged');
    return err.message || msg('genericError');
  }
  return msg('genericError');
}

async function locked<T>(fn: () => Promise<T>, label?: string): Promise<T | undefined> {
  if (state.busy) return undefined;
  setBusy(true, label ?? msg('working'));
  try {
    return await fn();
  } catch (err) {
    showToast(apiMessage(err), 'error');
    if (err instanceof ApiError && err.status === 409 && state.session) {
      try { applySession(await getSession(state.session.id), { jumpLatest: true }); } catch { /* Keep the current scene available. */ }
    }
    return undefined;
  } finally {
    setBusy(false);
  }
}

function parsePlayers(raw: string): string[] {
  return raw
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
    .slice(0, 6);
}

function saveSessionId(id: string | null): void {
  if (id) localStorage.setItem(STORAGE_KEY, id);
  else localStorage.removeItem(STORAGE_KEY);
}

function tvLink(id: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set('session', id);
  url.hash = '';
  return url.toString();
}

function setLiveStatus(status: LiveStatus): void {
  const pill = $('live-status');
  pill.dataset.state = status;
  const key: MsgKey =
    status === 'live' ? 'live'
      : status === 'reconnecting' ? 'reconnecting'
        : status === 'offline' ? 'offline'
          : 'connecting';
  text($('live-label'), msg(key));
}

function setLanguage(lang: Language): void {
  state.lang = lang;
  localStorage.setItem(LANG_KEY, lang);
  applyStaticI18n(lang);
  document.querySelectorAll<HTMLButtonElement>('.lang-btn').forEach(btn => {
    const active = btn.dataset.lang === lang;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
  updateProviderBadge();
  window.dispatchEvent(new CustomEvent('rpg-night:language', { detail: lang }));
  if (state.session) renderSession(state.session);
}

function updateProviderBadge(): void {
  const badge = $('provider-badge');
  const label = $('provider-label');
  const provider = state.config?.provider ?? 'demo';
  badge.dataset.provider = provider;
  text(label, provider === 'bedrock' ? msg('bedrockMode') : msg('demoMode'));
}

function showLanding(show: boolean): void {
  setHidden($('landing'), !show);
  setHidden($('app'), show);
  const skip = document.querySelector<HTMLAnchorElement>('.skip-link');
  if (skip) skip.href = show ? '#start-form' : '#main';
}

function switchTab(tab: 'story' | 'comic'): void {
  state.tab = tab;
  const storyTab = $('tab-story');
  const comicTab = $('tab-comic');
  const storyView = $('view-story');
  const comicView = $('view-comic');
  const isStory = tab === 'story';
  storyTab.classList.toggle('is-active', isStory);
  comicTab.classList.toggle('is-active', !isStory);
  storyTab.setAttribute('aria-selected', isStory ? 'true' : 'false');
  comicTab.setAttribute('aria-selected', isStory ? 'false' : 'true');
  storyTab.tabIndex = isStory ? 0 : -1;
  comicTab.tabIndex = isStory ? -1 : 0;
  setHidden(storyView, !isStory);
  setHidden(comicView, isStory);
  if (!isStory && state.session) renderComic(state.session);
}

function stopSse(): void {
  state.sse?.close();
  state.sse = null;
}

function attachSse(id: string): void {
  stopSse();
  state.sse = connectSessionEvents(id, {
    onSession: session => applySession(session, { fromSse: true }),
    onStatus: setLiveStatus,
  });
}

function applySession(session: Session, opts?: { fromSse?: boolean; jumpLatest?: boolean }): void {
  const prev = state.session;
  if (prev?.id === session.id && session.revision < prev.revision) return;
  const sceneChanged =
    !prev ||
    prev.scenes.length !== session.scenes.length ||
    prev.scenes.at(-1)?.id !== session.scenes.at(-1)?.id;

  state.session = session;
  saveSessionId(session.id);

  if (opts?.jumpLatest || !prev || sceneChanged) {
    state.sceneIndex = Math.max(0, session.scenes.length - 1);
  } else {
    state.sceneIndex = Math.min(state.sceneIndex, Math.max(0, session.scenes.length - 1));
  }

  showLanding(false);
  renderSession(session);

  if (session.status === 'ended') {
    mic?.stop();
    if (opts?.jumpLatest || sceneChanged) switchTab('comic');
  }

  if (sceneChanged) {
    const scene = session.scenes.at(-1);
    if (scene) {
      const key = `${session.id}:${scene.id}`;
      tts.speak(scene.narration, session.language, key);
    }
  }
}

function currentScene(session: Session) {
  return session.scenes[state.sceneIndex] ?? session.scenes.at(-1) ?? null;
}

function isViewingLatest(session: Session): boolean {
  return state.sceneIndex >= session.scenes.length - 1;
}

function refreshActionLocks(): void {
  const session = state.session;
  const ended = !session || session.status === 'ended';
  const past = !!session && !isViewingLatest(session);
  const lockPlay = ended || past || state.busy;

  const choiceButtons = document.querySelectorAll<HTMLButtonElement>('#choices .choice-btn');
  choiceButtons.forEach(btn => { btn.disabled = lockPlay; });

  ($('action-input') as HTMLInputElement).disabled = lockPlay;
  ($('action-btn') as HTMLButtonElement).disabled = lockPlay;
  ($('dice-btn') as HTMLButtonElement).disabled = lockPlay;
  ($('mic-btn') as HTMLButtonElement).disabled = lockPlay || !mic;
  ($('end-btn') as HTMLButtonElement).disabled = ended || state.busy;
  setHidden($('new-adventure-btn'), !(session && session.status === 'ended'));
}

function renderSession(session: Session): void {
  const scene = currentScene(session);
  const maxScenes = session.status === 'ended' ? session.scenes.length : session.provider === 'demo' ? 6 : state.config?.maxScenes ?? 8;
  const img = $('scene-image') as HTMLImageElement;

  if (scene) {
    if (img.src !== new URL(scene.imageUrl, window.location.origin).href) {
      img.src = scene.imageUrl;
    }
    img.alt = scene.title;
    text($('scene-title'), scene.title);
    text($('scene-narration'), scene.narration);
    text($('chapter-badge'), `${scene.number} / ${maxScenes}`);
    text($('chapter-label'), msg('chapterOf', { n: scene.number, max: maxScenes }));

    const outcome = $('scene-outcome');
    if (scene.outcome) {
      const labels: Record<string, MsgKey> = { success: 'outcomeSuccess', setback: 'outcomeSetback', ally: 'outcomeAlly', trust: 'outcomeTrust' };
      text(outcome, labels[scene.outcome] ? msg(labels[scene.outcome]) : scene.outcome);
      setHidden(outcome, false);
    } else {
      setHidden(outcome, true);
    }
  }

  const playersList = $('players-list');
  clearChildren(playersList);
  for (const name of session.players) {
    playersList.appendChild(createEl('li', { text: name }));
  }

  const invList = $('inventory-list');
  clearChildren(invList);
  const empty = $('inventory-empty');
  if (session.inventory.length === 0) {
    setHidden(empty, false);
  } else {
    setHidden(empty, true);
    for (const item of session.inventory) {
      invList.appendChild(createEl('li', { text: item }));
    }
  }

  const rollBlock = $('roll-block');
  if (session.lastRoll) {
    setHidden(rollBlock, false);
    const roll = session.lastRoll;
    const rollEl = $('roll-display');
    clearChildren(rollEl);
    const main = createEl('span', {
      text: msg('rollResult', { sides: roll.sides, total: roll.total }),
    });
    rollEl.appendChild(main);
    rollEl.appendChild(document.createTextNode(' · '));
    const ok = createEl('span', {
      className: roll.success ? 'roll-ok' : 'roll-fail',
      text: roll.success ? msg('rollSuccess') : msg('rollFail'),
    });
    rollEl.appendChild(ok);
    if (roll.used) {
      rollEl.appendChild(document.createTextNode(` (${msg('rollUsed')})`));
    }
  } else {
    setHidden(rollBlock, true);
  }

  const warnings = $('warnings');
  if (session.warnings.length) {
    text(warnings, session.warnings.join(' · '));
    setHidden(warnings, false);
  } else {
    setHidden(warnings, true);
  }

  renderChoices(session, scene);
  updateChapterNav(session);
  renderComic(session);
  refreshActionLocks();

  if (session.status === 'ended') {
    text($('comic-heading'), session.title || msg('comicTitle'));
  }
}

function renderChoices(session: Session, scene: ReturnType<typeof currentScene>): void {
  const box = $('choices');
  clearChildren(box);
  if (!scene || session.status === 'ended') return;

  if (!isViewingLatest(session)) {
    box.appendChild(createEl('p', { className: 'muted-note', text: msg('viewingPast') }));
    return;
  }

  scene.choices.forEach((choice, i) => {
    const btn = createEl('button', {
      className: `choice-btn${choice.risky ? ' is-risky' : ''}`,
      attrs: { type: 'button', 'data-choice-id': choice.id },
    });
    const label = createEl('span', {
      className: 'choice-label',
      text: choice.risky ? msg('choiceRisky') : `${msg('choiceSafe')} ${i + 1}`,
    });
    const body = createEl('span', { className: 'choice-text', text: choice.text });
    btn.appendChild(label);
    btn.appendChild(body);
    btn.addEventListener('click', () => {
      void locked(async () => {
        const next = await postAction(session.id, choice.text, choice.id);
        applySession(next, { jumpLatest: true });
      });
    });
    box.appendChild(btn);
  });
}

function updateChapterNav(session: Session): void {
  const prev = $('prev-chapter') as HTMLButtonElement;
  const next = $('next-chapter') as HTMLButtonElement;
  prev.disabled = state.sceneIndex <= 0;
  next.disabled = state.sceneIndex >= session.scenes.length - 1;
}

function renderComic(session: Session): void {
  const grid = $('comic-grid');
  const empty = $('comic-empty');
  clearChildren(grid);

  if (!session.scenes.length) {
    setHidden(empty, false);
    return;
  }
  setHidden(empty, true);

  for (const scene of session.scenes) {
    const panel = createEl('article', { className: 'comic-panel' });
    const img = createEl('img', {
      className: 'comic-panel-image',
      attrs: { src: scene.imageUrl, alt: scene.title, loading: 'eager' },
    });
    const body = createEl('div', { className: 'comic-panel-body' });
    body.appendChild(createEl('span', { className: 'comic-panel-num', text: String(scene.number) }));
    body.appendChild(createEl('h3', { className: 'comic-panel-title', text: scene.title }));
    if (scene.action) {
      body.appendChild(createEl('p', {
        className: 'comic-panel-action',
        text: `${msg('choicePrefix')} · ${scene.action}`,
      }));
    }
    body.appendChild(createEl('p', { className: 'comic-panel-caption', text: scene.narration }));
    panel.appendChild(img);
    panel.appendChild(body);
    grid.appendChild(panel);
  }
}

async function beginAdventure(): Promise<void> {
  const playersInput = $('players-input') as HTMLInputElement;
  const players = parsePlayers(playersInput.value);
  if (players.length === 0) {
    showToast(msg('needPlayers'), 'error');
    playersInput.focus();
    return;
  }
  if (players.some(name => name.length > 32)) {
    showToast(msg('nameTooLong'), 'error'); playersInput.focus(); return;
  }
  if (playersInput.value.split(',').map(s => s.trim()).filter(Boolean).length > 6) {
    showToast(msg('tooManyPlayers'), 'error');
    playersInput.focus();
    return;
  }
  const worldInput = document.querySelector<HTMLInputElement>('input[name="world"]:checked');
  const world = (worldInput?.value ?? 'fantasy') as World;
  state.world = world;

  await locked(async () => {
    const session = await createSession({ world, language: state.lang, players });
    attachSse(session.id);
    applySession(session, { jumpLatest: true });
    switchTab('story');
    history.replaceState(null, '', `?session=${encodeURIComponent(session.id)}`);
  }, msg('working'));
}

async function restoreSession(id: string): Promise<boolean> {
  try {
    const session = await getSession(id);
    state.lang = session.language;
    applyStaticI18n(state.lang);
    document.querySelectorAll<HTMLButtonElement>('.lang-btn').forEach(btn => {
      const active = btn.dataset.lang === state.lang;
      btn.classList.toggle('is-active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    attachSse(session.id);
    applySession(session, { jumpLatest: true });
    if (session.status === 'ended') switchTab('comic');
    else switchTab('story');
    history.replaceState(null, '', `?session=${encodeURIComponent(session.id)}`);
    return true;
  } catch (err) {
    saveSessionId(null);
    if (err instanceof ApiError && err.status === 404) {
      showToast(msg('sessionMissing'), 'error');
    } else {
      showToast(apiMessage(err), 'error');
    }
    return false;
  }
}

function setupMic(): void {
  const btn = $('mic-btn') as HTMLButtonElement;
  if (!speechRecognitionSupported()) {
    btn.disabled = true;
    btn.title = msg('speechUnsupported');
    return;
  }
  mic = createMic({
    getLang: () => state.session?.language ?? state.lang,
    onTranscript: (spoken) => {
      const input = $('action-input') as HTMLInputElement;
      input.value = spoken;
      void submitCustomAction();
    },
    onListening: (listening) => {
      btn.setAttribute('aria-pressed', listening ? 'true' : 'false');
      const label = btn.querySelector('span');
      if (label) text(label, listening ? msg('listening') : msg('speak'));
    },
    onError: () => {
      showToast(msg('speechError'), 'error');
      btn.setAttribute('aria-pressed', 'false');
      const label = btn.querySelector('span');
      if (label) text(label, msg('speak'));
    },
  });
  btn.addEventListener('click', () => {
    if (!mic) {
      showToast(msg('speechUnsupported'), 'error');
      return;
    }
    if (mic.listening) mic.stop();
    else { tts.stop(); mic.start(); }
  });
}

async function submitCustomAction(): Promise<void> {
  const session = state.session;
  if (!session || session.status === 'ended' || !isViewingLatest(session)) return;
  const input = $('action-input') as HTMLInputElement;
  const action = input.value.trim();
  if (!action) return;
  const normalize = (value: string) => value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
  const spoken = normalize(action);
  const ordinal = spoken.match(/^(?:option|choice|opcion) (1|2|3|one|two|three|uno|dos|tres)$/);
  const ordinals: Record<string, number> = { '1': 0, one: 0, uno: 0, '2': 1, two: 1, dos: 1, '3': 2, three: 2, tres: 2 };
  const choices = session.scenes.at(-1)!.choices;
  const choice = ordinal ? choices[ordinals[ordinal[1]]] : choices.find(c => normalize(c.text) === spoken);
  await locked(async () => {
    const next = await postAction(session.id, choice?.text ?? action, choice?.id);
    input.value = '';
    applySession(next, { jumpLatest: true });
  });
}

function wireUi(): void {
  initHostPanel({ getLanguage: () => state.lang });
  document.querySelectorAll<HTMLButtonElement>('.lang-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const lang = btn.dataset.lang as Language;
      if (lang === 'en' || lang === 'es') setLanguage(lang);
    });
  });

  $('start-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    void beginAdventure();
  });

  $('resume-btn').addEventListener('click', () => {
    const id = localStorage.getItem(STORAGE_KEY);
    if (id) void restoreSession(id);
  });

  $('discard-resume-btn').addEventListener('click', () => {
    saveSessionId(null);
    setHidden($('resume-hint'), true);
  });

  $('tab-story').addEventListener('click', () => switchTab('story'));
  $('tab-comic').addEventListener('click', () => switchTab('comic'));
  document.querySelector('.tabs')?.addEventListener('keydown', event => {
    const key = (event as KeyboardEvent).key;
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) return;
    event.preventDefault();
    const tab = key === 'Home' ? 'story' : key === 'End' ? 'comic' : state.tab === 'story' ? 'comic' : 'story';
    switchTab(tab); $(`tab-${tab}`).focus();
  });

  $('share-btn').addEventListener('click', async () => {
    const id = state.session?.id;
    if (!id) return;
    const link = tvLink(id);
    try {
      await navigator.clipboard.writeText(link);
      showToast(msg('linkCopied'));
    } catch {
      showToast(msg('linkCopyFailed'), 'error');
    }
  });

  $('fullscreen-btn').addEventListener('click', async () => {
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
      else await document.exitFullscreen();
    } catch { /* ignore */ }
  });

  document.addEventListener('fullscreenchange', () => {
    const btn = $('fullscreen-btn');
    btn.setAttribute(
      'aria-label',
      document.fullscreenElement ? msg('exitFullscreen') : msg('fullscreen'),
    );
  });

  $('prev-chapter').addEventListener('click', () => {
    if (!state.session || state.sceneIndex <= 0) return;
    state.sceneIndex -= 1;
    renderSession(state.session);
  });
  $('next-chapter').addEventListener('click', () => {
    if (!state.session || state.sceneIndex >= state.session.scenes.length - 1) return;
    state.sceneIndex += 1;
    renderSession(state.session);
  });

  $('action-form').addEventListener('submit', (ev) => {
    ev.preventDefault();
    void submitCustomAction();
  });

  $('dice-btn').addEventListener('click', () => {
    const session = state.session;
    if (!session || session.status === 'ended' || !isViewingLatest(session)) return;
    void locked(async () => {
      const next = await postDice(session.id, 20, 1, 0);
      applySession(next);
    });
  });

  $('tts-btn').addEventListener('click', () => {
    const btn = $('tts-btn') as HTMLButtonElement;
    if (!speechSynthesisSupported()) {
      showToast(msg('ttsUnsupported'), 'error');
      return;
    }
    const next = !tts.enabled;
    tts.setEnabled(next);
    btn.setAttribute('aria-pressed', next ? 'true' : 'false');
    text(btn, next ? msg('muteNarration') : msg('enableNarration'));
    if (next && state.session) {
      const scene = currentScene(state.session);
      if (scene) tts.speak(scene.narration, state.session.language, `${state.session.id}:${scene.id}`);
    }
  });

  $('end-btn').addEventListener('click', () => {
    const dialog = $('end-dialog') as HTMLDialogElement;
    dialog.showModal();
  });

  $('end-dialog').addEventListener('close', () => {
    const dialog = $('end-dialog') as HTMLDialogElement;
    if (dialog.returnValue !== 'confirm') return;
    const session = state.session;
    if (!session || session.status === 'ended') return;
    void locked(async () => {
      const next = await postEnd(session.id);
      applySession(next, { jumpLatest: true });
      switchTab('comic');
    });
  });

  $('download-svg').addEventListener('click', () => {
    const id = state.session?.id;
    if (!id) return;
    const a = document.createElement('a');
    a.href = comicSvgUrl(id);
    a.download = `rpg-night-${state.session?.world ?? 'adventure'}.svg`;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  });

  $('download-png').addEventListener('click', () => {
    const session = state.session;
    if (!session?.scenes.length) return;
    void locked(async () => {
      try {
        const blob = await exportComicPng(session);
        downloadBlob(blob, `rpg-night-${session.world}.png`);
      } catch {
        showToast(msg('pngFailed'), 'error');
      }
    }, msg('pngExporting'));
  });

  $('print-btn').addEventListener('click', () => {
    switchTab('comic');
    window.print();
  });

  $('new-adventure-btn').addEventListener('click', () => {
    mic?.stop();
    stopSse();
    tts.stop();
    state.session = null;
    saveSessionId(null);
    history.replaceState(null, '', window.location.pathname);
    showLanding(true);
    setHidden($('resume-hint'), true);
    switchTab('story');
    setLiveStatus('offline');
  });

  // World preview: update landing art feel via CSS data attr
  document.querySelectorAll<HTMLInputElement>('input[name="world"]').forEach(input => {
    input.addEventListener('change', () => {
      if (input.checked) {
        state.world = input.value as World;
        const art = document.querySelector('.landing-art');
        if (art) (art as HTMLElement).dataset.world = state.world;
        // Warm the preview endpoint for scenic art availability
        const preload = new Image();
        preload.src = previewUrl(state.world);
      }
    });
  });

  setupMic();
}

async function boot(): Promise<void> {
  const params = new URLSearchParams(window.location.search);
  const hostConversationId = params.get('host');
  if (hostConversationId) {
    await initHostTv(hostConversationId);
    return;
  }

  applyStaticI18n(state.lang);
  document.querySelectorAll<HTMLButtonElement>('.lang-btn').forEach(btn => {
    const active = btn.dataset.lang === state.lang;
    btn.classList.toggle('is-active', active);
    btn.setAttribute('aria-pressed', active ? 'true' : 'false');
  });

  wireUi();

  try {
    state.config = await getConfig();
  } catch {
    state.config = { provider: 'demo', maxScenes: 8, version: '1.0.0' };
  }
  updateProviderBadge();

  const fromQuery = params.get('session');
  const stored = localStorage.getItem(STORAGE_KEY);

  if (fromQuery) {
    const ok = await restoreSession(fromQuery);
    if (!ok) showLanding(true);
    return;
  }

  if (stored) {
    setHidden($('resume-hint'), false);
  }
  showLanding(true);
}

void boot();
