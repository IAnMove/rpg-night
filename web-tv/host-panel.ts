import type { HostResponse } from '../shared/host-schema.js';
import type { Language } from '../shared/types.js';
import { $, clearChildren, createEl, setHidden, text } from './dom.js';
import { createHostConversation, controlHostConversation, getPendingHostOperation, HostApiError, restoreHostConversation, sendHostTurn } from './host-api.js';
import { createMic, createTts, speechSynthesisSupported, type MicController, type TtsController } from './speech.js';
import { t, type MsgKey } from './i18n.js';

const SESSION_KEY = 'rpg-night.v2.sessionId';
const CONVERSATION_KEY = 'rpg-night.v2.conversationId';
const CONVERSATION_LOCALE_KEY = 'rpg-night.v2.conversationLocale';

type HostTurn = Extract<HostResponse, { kind: 'turn' }>['turn'];

export function initHostPanel(options: {
  getLanguage: () => Language;
}): void {
  const panel = $('host-panel');
  const landing = $('landing');
  const app = $('app');
  const transcript = $('host-transcript');
  const input = $('host-input') as HTMLInputElement;
  const sendButton = $('host-send-btn') as HTMLButtonElement;
  const micButton = $('host-mic-btn') as HTMLButtonElement;
  const pauseButton = $('host-pause-btn') as HTMLButtonElement;
  const ttsButton = $('host-tts-btn') as HTMLButtonElement;
  const tts: TtsController = createTts();
  let conversationId: string | null = null;
  let turn: HostTurn | null = null;
  let busy = false;
  let paused = false;
  let operationPending = false;
  let operationPollTimer: number | null = null;
  let operationPollAttempts = 0;
  let mic: MicController | null = null;

  const msg = (key: MsgKey, vars?: Record<string, string | number>) => t(options.getLanguage(), key, vars);

  const setStatus = (state: 'idle' | 'thinking' | 'listening' | 'paused' | 'live', label?: string) => {
    const status = $('host-status');
    status.dataset.state = state;
    text(status, label ?? msg(state === 'thinking' ? 'hostThinking' : state === 'listening' ? 'hostListening' : state === 'paused' ? 'hostPaused' : state === 'live' ? 'live' : 'hostReady'));
  };

  const addMessage = (role: 'player' | 'gm', value: string) => {
    const content = value.trim();
    if (!content) return;
    const item = createEl('p', { className: 'host-message', text: content });
    item.dataset.role = role;
    transcript.append(item);
    while (transcript.childElementCount > 30) transcript.firstElementChild?.remove();
    transcript.scrollTop = transcript.scrollHeight;
  };

  const showError = (value: string | null) => {
    const element = $('host-error');
    text(element, value ?? '');
    setHidden(element, !value);
  };

  const setBusy = (value: boolean) => {
    busy = value;
    sendButton.disabled = value || paused || operationPending;
    input.disabled = value || paused || operationPending;
    micButton.disabled = value || paused || operationPending || !mic;
    document.querySelectorAll<HTMLButtonElement>('.host-choice').forEach(button => { button.disabled = value || paused || operationPending; });
    pauseButton.disabled = value || !turn || turn.phase === 'ended';
    ($('host-new-btn') as HTMLButtonElement).disabled = value;
  };

  const speak = (value: string) => {
    if (tts.enabled) tts.speak(value, options.getLanguage(), `host:${conversationId ?? 'pregame'}:${Date.now()}`);
  };

  const renderTurn = (next: HostTurn) => {
    turn = next;
    localStorage.setItem(SESSION_KEY, next.session_id);
    text($('host-scene-label'), `${next.scene_id.replaceAll('-', ' ')} · ${next.phase}`);
    text($('host-narration'), next.narration);
    setHidden($('host-question'), true);
    const choices = $('host-choices');
    clearChildren(choices);
    for (const [index, choice] of next.choices.entries()) {
      const button = createEl('button', { className: 'host-choice', text: choice.label, attrs: { type: 'button' } });
      button.addEventListener('click', () => {
        const language = options.getLanguage();
        void submit(language === 'es'
          ? `Elegimos la opción ${index + 1}: ${choice.label}`
          : `We choose option ${index + 1}: ${choice.label}`);
      });
      choices.append(button);
    }
    const inventory = $('host-inventory');
    text(inventory, next.inventory.length
      ? `${msg('hostInventory')}: ${next.inventory.map(item => item.name).join(', ')}`
      : `${msg('hostInventory')}: —`);
    setHidden(inventory, false);
    const pendingCheck = next.pending_check;
    const check = $('host-check');
    text(check, pendingCheck ? `${msg('hostCheck')} · ${pendingCheck.prompt} · DC ${pendingCheck.difficulty_class}` : '');
    setHidden(check, !pendingCheck);
    pauseButton.disabled = next.phase === 'ended' || busy;
    text(pauseButton, paused ? msg('resumeGame') : msg('pauseGame'));
    if (next.phase === 'ended') {
      text($('host-scene-label'), msg('hostEnded'));
      pauseButton.disabled = true;
      setHidden($('host-new-btn'), false);
    } else {
      setHidden($('host-new-btn'), true);
    }
  };

  const handleResponse = (response: HostResponse) => {
    showError(null);
    if ('conversation' in response) {
      conversationId = response.conversation.conversation_id;
      localStorage.setItem(CONVERSATION_KEY, conversationId);
      localStorage.setItem(CONVERSATION_LOCALE_KEY, response.conversation.locale);
      paused = response.conversation.paused;
      setHidden($('host-tv-btn'), false);
      if (response.conversation.session_id) localStorage.setItem(SESSION_KEY, response.conversation.session_id);
    }
    if (response.kind === 'message') {
      addMessage('gm', response.assistant_text);
      speak(response.assistant_text);
      return;
    }
    if (response.kind === 'turn') {
      renderTurn(response.turn);
      addMessage('gm', response.assistant_text);
      speak(response.assistant_text);
      return;
    }
    if (response.kind === 'clarification') {
      renderTurn(response.turn);
      text($('host-question'), response.question);
      setHidden($('host-question'), false);
      addMessage('gm', response.question);
      speak(response.question);
      return;
    }
    if (response.kind === 'operation') {
      if (response.operation.status === 'pending') {
        operationPending = true;
        addMessage('gm', msg('hostStarting'));
        if (!operationPollTimer) scheduleOperationPoll();
      } else if (response.operation.status === 'ready') {
        operationPending = false;
        operationPollAttempts = 0;
        const title = response.operation.result.kind === 'adventure' ? response.operation.result.title : response.operation.kind;
        const ready = msg('hostAdventureReady', { title });
        addMessage('gm', ready);
        speak(ready);
      } else {
        operationPending = false;
        operationPollAttempts = 0;
        const failed = `${msg('hostAdventureFailed')} ${response.operation.error.message}`;
        addMessage('gm', failed);
        speak(failed);
      }
      setBusy(busy);
      return;
    }
    addMessage('gm', response.message);
    showError(response.message);
  };

  const messageForError = (error: unknown) => {
    if (error instanceof HostApiError && error.message === 'NETWORK') return msg('hostError');
    return error instanceof Error ? error.message : msg('hostError');
  };

  async function submit(raw: string): Promise<void> {
    const value = raw.trim();
    if (!value || !conversationId || busy || paused || operationPending) return;
    setHidden($('host-question'), true);
    addMessage('player', value);
    input.value = '';
    showError(null);
    setBusy(true);
    setStatus('thinking');
    try {
      const response = await sendHostTurn(conversationId, {
        request_id: crypto.randomUUID(),
        text: value,
        ...(turn ? { expected_revision: turn.revision } : {}),
      });
      handleResponse(response);
      setStatus(paused ? 'paused' : operationPending ? 'thinking' : 'live');
    } catch (error) {
      const message = messageForError(error);
      showError(message);
      addMessage('gm', message);
      setStatus('idle');
    } finally {
      setBusy(false);
      input.focus();
    }
  }

  function scheduleOperationPoll(delay = 1200): void {
    operationPollTimer = window.setTimeout(() => {
      operationPollTimer = null;
      void pollPendingOperation();
    }, delay);
  }

  async function pollPendingOperation(): Promise<void> {
    if (!operationPending || !conversationId) return;
    operationPollAttempts++;
    try {
      const response = await getPendingHostOperation(conversationId);
      if (response.kind === 'operation' && response.operation.status === 'pending') {
        if (operationPollAttempts <= 120) scheduleOperationPoll(Math.min(5000, 1200 + operationPollAttempts * 100));
        else {
          operationPending = false;
          setBusy(false);
          showError(msg('hostOperationTimeout'));
        }
        return;
      }
      operationPending = false;
      handleResponse(response);
      setStatus(paused ? 'paused' : 'live');
      setBusy(false);
    } catch (error) {
      if (operationPollAttempts <= 120) scheduleOperationPoll(Math.min(5000, 1200 + operationPollAttempts * 100));
      else {
        operationPending = false;
        setBusy(false);
        showError(messageForError(error));
      }
    }
  }

  const startMic = () => {
    if (!mic) {
      showError(options.getLanguage() === 'es' ? 'Este navegador no ofrece reconocimiento de voz. Puedes escribir tu acción.' : 'Speech recognition is unavailable in this browser. You can type your action.');
      return;
    }
    tts.stop();
    mic.start();
  };

  mic = createMic({
    getLang: options.getLanguage,
    onTranscript: value => { input.value = value; void submit(value); },
    onListening: listening => {
      setStatus(listening ? 'listening' : paused ? 'paused' : busy ? 'thinking' : 'live');
      micButton.setAttribute('aria-pressed', listening ? 'true' : 'false');
    },
    onError: () => showError(options.getLanguage() === 'es' ? 'No se ha entendido el audio. Prueba otra vez o escribe la acción.' : 'Speech could not be recognized. Try again or type your action.'),
  });

  const open = async () => {
    if (busy) return;
    const language = options.getLanguage();
    showError(null);
    clearChildren(transcript);
    turn = null;
    paused = false;
    localStorage.setItem('rpg-night.v2.locale', language);
    setBusy(true);
    setStatus('thinking', msg('hostStarting'));
    setHidden(landing, true);
    setHidden(app, true);
    setHidden(panel, false);
    try {
      const savedConversation = localStorage.getItem(CONVERSATION_KEY) ?? undefined;
      const savedSession = localStorage.getItem(SESSION_KEY) ?? undefined;
      const savedLocale = localStorage.getItem(CONVERSATION_LOCALE_KEY);
      const restoreLocale = savedLocale === 'es' || savedLocale === 'en' ? savedLocale : language;
      const response = savedConversation
        ? await restoreHostConversation(restoreLocale, savedConversation)
        : await createHostConversation(language, savedSession);
      handleResponse(response);
      if (savedConversation) {
        const operation = await getPendingHostOperation(savedConversation);
        if (operation.kind === 'operation') handleResponse(operation);
        else if (operation.kind === 'error' && operation.code !== 'NOT_FOUND') showError(operation.message);
      }
      if (response.kind === 'message' && !savedSession && !savedConversation) {
        const playersRaw = ($('players-input') as HTMLInputElement).value;
        const players = playersRaw.split(',').map(name => name.trim()).filter(Boolean).slice(0, 6);
        const party = players.length ? players.join(language === 'es' ? ', ' : ', ') : (language === 'es' ? 'el grupo' : 'the party');
        const starter = language === 'es'
          ? `Enséñanos las aventuras disponibles en español y ayúdanos a elegir. El grupo está formado por: ${party}. No empieces hasta que elijamos una.`
          : `Show us the adventures available in English and help us choose. The players are: ${party}. Do not start until we choose one.`;
        setBusy(false);
        await submit(starter);
      }
      setStatus(paused ? 'paused' : operationPending ? 'thinking' : 'live');
      input.focus();
    } catch (error) {
      showError(messageForError(error));
      setStatus('idle');
    } finally {
      setBusy(false);
    }
  };

  $('host-mode-btn').addEventListener('click', () => { void open(); });
  $('host-back-btn').addEventListener('click', () => {
    mic?.stop(); tts.stop();
    setHidden(panel, true); setHidden(landing, false);
  });
  $('host-turn-form').addEventListener('submit', event => {
    event.preventDefault();
    void submit(input.value);
  });
  micButton.addEventListener('click', startMic);
  ttsButton.addEventListener('click', () => {
    if (!speechSynthesisSupported()) {
      showError(options.getLanguage() === 'es' ? 'Este navegador no ofrece narración de voz.' : 'Speech synthesis is unavailable in this browser.');
      return;
    }
    const enabled = !tts.enabled;
    tts.setEnabled(enabled);
    ttsButton.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    text(ttsButton, msg(enabled ? 'muteNarration' : 'enableNarration'));
  });
  pauseButton.addEventListener('click', async () => {
    if (!conversationId || busy || !turn) return;
    setBusy(true);
    tts.stop(); mic?.stop();
    try {
      const response = await controlHostConversation(conversationId, paused ? 'resume' : 'pause', turn.revision);
      paused = !paused;
      handleResponse(response);
      setStatus(paused ? 'paused' : 'live');
    } catch (error) {
      showError(messageForError(error));
    } finally { setBusy(false); }
  });

  $('host-new-btn').addEventListener('click', () => {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(CONVERSATION_KEY);
    localStorage.removeItem(CONVERSATION_LOCALE_KEY);
    if (operationPollTimer) window.clearTimeout(operationPollTimer);
    operationPollTimer = null;
    operationPollAttempts = 0;
    operationPending = false;
    conversationId = null;
    setHidden($('host-tv-btn'), true);
    turn = null;
    paused = false;
    tts.stop(); mic?.stop();
    void open();
  });

  $('host-tv-btn').addEventListener('click', () => {
    if (!conversationId) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('session');
    url.searchParams.set('host', conversationId);
    url.hash = '';
    window.open(url.toString(), '_blank', 'noopener,noreferrer');
  });

  window.addEventListener('rpg-night:language', event => {
    const language = (event as CustomEvent<Language>).detail;
    if (language !== 'en' && language !== 'es') return;
    text($('host-mode-badge'), msg('localHostBadge'));
    if (turn) renderTurn(turn);
  });
}
