import type { Language } from '../shared/types.js';

/** Minimal SpeechRecognition typings for browsers that expose the API. */
interface SpeechRecognitionResultLike {
  readonly isFinal: boolean;
  readonly 0: { transcript: string };
}
interface SpeechRecognitionEventLike extends Event {
  readonly resultIndex: number;
  readonly results: ArrayLike<SpeechRecognitionResultLike>;
}
interface SpeechRecognitionErrorEventLike extends Event {
  readonly error: string;
}
interface SpeechRecognitionLike extends EventTarget {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  start(): void;
  stop(): void;
  abort(): void;
  onresult: ((ev: SpeechRecognitionEventLike) => void) | null;
  onerror: ((ev: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
}
interface SpeechRecognitionConstructor {
  new (): SpeechRecognitionLike;
}

function getRecognitionCtor(): SpeechRecognitionConstructor | null {
  const w = window as Window & {
    SpeechRecognition?: SpeechRecognitionConstructor;
    webkitSpeechRecognition?: SpeechRecognitionConstructor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function speechRecognitionSupported(): boolean {
  return getRecognitionCtor() != null;
}

export function speechSynthesisSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
}

export type MicController = {
  listening: boolean;
  start: () => void;
  stop: () => void;
};

/**
 * One-shot recognition. Does not auto-restart after end.
 */
export function createMic(opts: {
  getLang: () => Language;
  onTranscript: (text: string) => void;
  onListening: (listening: boolean) => void;
  onError: (message: string) => void;
}): MicController | null {
  const Ctor = getRecognitionCtor();
  if (!Ctor) return null;

  let recognition: SpeechRecognitionLike | null = null;
  let listening = false;
  let stopRequested = false;

  const setListening = (value: boolean) => {
    listening = value;
    opts.onListening(value);
  };

  return {
    get listening() { return listening; },
    start() {
      if (listening) return;
      stopRequested = false;
      recognition = new Ctor();
      recognition.lang = opts.getLang() === 'es' ? 'es-ES' : 'en-US';
      recognition.continuous = false;
      recognition.interimResults = false;
      recognition.maxAlternatives = 1;
      recognition.onresult = (ev) => {
        const parts: string[] = [];
        for (let i = ev.resultIndex; i < ev.results.length; i++) {
          const result = ev.results[i];
          if (result?.isFinal) parts.push(result[0].transcript);
        }
        const text = parts.join(' ').trim();
        if (text) opts.onTranscript(text);
      };
      recognition.onerror = (ev) => {
        if (ev.error === 'aborted' || ev.error === 'no-speech') return;
        opts.onError(ev.error);
      };
      recognition.onend = () => {
        setListening(false);
        recognition = null;
        // Explicit: do not auto-restart.
        if (!stopRequested) { /* one-shot complete */ }
      };
      try {
        recognition.start();
        setListening(true);
      } catch {
        setListening(false);
        opts.onError('start-failed');
      }
    },
    stop() {
      stopRequested = true;
      try { recognition?.stop(); } catch { /* ignore */ }
      try { recognition?.abort(); } catch { /* ignore */ }
      setListening(false);
      recognition = null;
    },
  };
}

export type TtsController = {
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  speak: (text: string, lang: Language, sceneKey: string) => void;
  stop: () => void;
};

/** Narration off by default. Skips repeat for the same sceneKey (e.g. dice-only updates). */
export function createTts(): TtsController {
  let enabled = false;
  let lastKey = '';

  return {
    get enabled() { return enabled; },
    setEnabled(on: boolean) {
      if (on && !enabled) lastKey = '';
      enabled = on;
      if (!on) {
        try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
      }
    },
    speak(text: string, lang: Language, sceneKey: string) {
      if (!enabled || !speechSynthesisSupported() || !text.trim()) return;
      if (sceneKey && sceneKey === lastKey) return;
      lastKey = sceneKey;
      try {
        window.speechSynthesis.cancel();
        const u = new SpeechSynthesisUtterance(text);
        u.lang = lang === 'es' ? 'es-ES' : 'en-US';
        u.rate = 1;
        window.speechSynthesis.speak(u);
      } catch { /* ignore */ }
    },
    stop() {
      lastKey = '';
      try { window.speechSynthesis?.cancel(); } catch { /* ignore */ }
    },
  };
}
