import type { Language } from '../shared/types.js';

const dict = {
  skipToContent: { en: 'Skip to content', es: 'Saltar al contenido' },
  eyebrow: {
    en: 'Voice-led adventures · Shared on your TV',
    es: 'Aventuras por voz · Compartidas en tu TV',
  },
  landingTitle: {
    en: 'Your next great story starts on the sofa.',
    es: 'Tu próxima gran historia empieza en el sofá.',
  },
  landingLede: {
    en: 'Pick a world, decide together, roll the dice, and take home a comic of the night. Try a local conversational host with optional browser voice; Alexa+ is simulated, not connected to an Echo.',
    es: 'Elige un mundo, decidid juntos, lanzad los dados y guardaos un cómic de la noche. Prueba un máster local con voz opcional del navegador; Alexa+ se simula, no está conectada a un Echo.',
  },
  demoMode: { en: 'Demo mode · no keys needed', es: 'Modo demo · sin claves' },
  bedrockMode: { en: 'Amazon Bedrock mode', es: 'Modo Amazon Bedrock' },
  localHostLaunch: { en: 'Play with the local Game Master', es: 'Jugar con el máster local' },
  localHostNote: { en: 'Ollama · real MCP tools · browser voice simulation', es: 'Ollama · herramientas MCP reales · voz simulada en el navegador' },
  localHostEyebrow: { en: 'Local conversational host', es: 'Máster conversacional local' },
  backToStart: { en: 'Back', es: 'Volver' },
  hostWelcome: { en: 'Your Game Master is ready', es: 'Tu máster está preparado' },
  hostInputPlaceholder: { en: 'Say what you want to do…', es: 'Cuenta qué queréis hacer…' },
  localHostBadge: { en: 'Local Ollama host · not connected to an Echo', es: 'Máster local con Ollama · no conectado a un Echo' },
  pauseGame: { en: 'Pause', es: 'Pausar' },
  resumeGame: { en: 'Resume', es: 'Reanudar' },
  hostReady: { en: 'Ready', es: 'Preparado' },
  hostThinking: { en: 'Thinking…', es: 'Pensando…' },
  hostListening: { en: 'Listening…', es: 'Escuchando…' },
  hostPaused: { en: 'Paused', es: 'En pausa' },
  hostStarting: { en: 'Starting a new story…', es: 'Empezando una nueva historia…' },
  hostOperationTimeout: { en: 'Story preparation is taking longer than expected. You can wait a little longer or refresh to check its status.', es: 'La preparación está tardando más de lo esperado. Puedes esperar un poco más o recargar para consultar su estado.' },
  hostAdventureReady: { en: '“{title}” is ready. Tell me if you would like to play it.', es: '«{title}» está lista. Decidme si queréis jugarla.' },
  hostAdventureFailed: { en: 'The adventure could not be prepared. You can choose one of the written stories.', es: 'No se pudo preparar la aventura. Podéis elegir una de las historias escritas.' },
  hostInventory: { en: 'Inventory', es: 'Inventario' },
  hostCheck: { en: 'Pending d20 check', es: 'Prueba de d20 pendiente' },
  hostError: { en: 'The local Game Master is unavailable. Check that RPG Night and Ollama are running.', es: 'El máster local no está disponible. Comprueba que RPG Night y Ollama estén en marcha.' },
  hostEnded: { en: 'This adventure has ended.', es: 'Esta aventura ha terminado.' },
  hostOpenTv: { en: 'Open shared screen', es: 'Abrir pantalla compartida' },
  chooseWorld: { en: 'Choose a world', es: 'Elige un mundo' },
  worldFantasy: { en: 'Fantasy', es: 'Fantasía' },
  worldFantasyDesc: { en: 'Castles, quests & moonlit roads', es: 'Castillos, misiones y caminos a la luna' },
  worldSpace: { en: 'Space', es: 'Espacio' },
  worldSpaceDesc: { en: 'Stars, signals & strange ships', es: 'Estrellas, señales y naves extrañas' },
  worldMystery: { en: 'Mystery', es: 'Misterio' },
  worldMysteryDesc: { en: 'Clues, shadows & secrets', es: 'Pistas, sombras y secretos' },
  partyNames: { en: 'Party names', es: 'Nombres del grupo' },
  partyPlaceholder: { en: 'Mira, Leo, Sam', es: 'Mira, Leo, Sam' },
  beginAdventure: { en: 'Begin adventure', es: 'Empezar aventura' },
  resumeSession: { en: 'Resume last adventure', es: 'Reanudar la última aventura' },
  startFresh: { en: 'Start fresh', es: 'Empezar de nuevo' },
  connecting: { en: 'Connecting…', es: 'Conectando…' },
  live: { en: 'Live', es: 'En vivo' },
  reconnecting: { en: 'Reconnecting…', es: 'Reconectando…' },
  offline: { en: 'Offline', es: 'Sin conexión' },
  tabStory: { en: 'Story', es: 'Historia' },
  tabComic: { en: 'Comic', es: 'Cómic' },
  shareLink: { en: 'Copy TV link', es: 'Copiar enlace de TV' },
  fullscreen: { en: 'Fullscreen', es: 'Pantalla completa' },
  exitFullscreen: { en: 'Exit fullscreen', es: 'Salir de pantalla completa' },
  players: { en: 'Players', es: 'Jugadores' },
  inventory: { en: 'Inventory', es: 'Inventario' },
  inventoryEmpty: { en: 'Nothing yet', es: 'Todavía nada' },
  lastRoll: { en: 'Last roll', es: 'Última tirada' },
  prevChapter: { en: 'Previous chapter', es: 'Capítulo anterior' },
  nextChapter: { en: 'Next chapter', es: 'Capítulo siguiente' },
  customAction: { en: 'Custom action', es: 'Acción libre' },
  actionPlaceholder: { en: 'Describe what you do…', es: 'Describe qué hacéis…' },
  sendAction: { en: 'Send', es: 'Enviar' },
  rollD20: { en: 'Roll d20', es: 'Tirar d20' },
  microphone: { en: 'Voice input', es: 'Entrada de voz' },
  speak: { en: 'Speak', es: 'Hablar' },
  listening: { en: 'Listening…', es: 'Escuchando…' },
  enableNarration: { en: 'Enable narration', es: 'Activar narración' },
  muteNarration: { en: 'Mute narration', es: 'Silenciar narración' },
  endAdventure: { en: 'End adventure', es: 'Terminar aventura' },
  comicTitle: { en: 'Your story, together', es: 'Vuestra historia, juntos' },
  downloadSvg: { en: 'Download SVG', es: 'Descargar SVG' },
  downloadPng: { en: 'Download PNG', es: 'Descargar PNG' },
  printPdf: { en: 'Print / Save PDF', es: 'Imprimir / Guardar PDF' },
  newAdventure: { en: 'New adventure', es: 'Nueva aventura' },
  comicEmpty: {
    en: 'Chapters will appear here as your story unfolds.',
    es: 'Los capítulos aparecerán aquí conforme avance la historia.',
  },
  endConfirmTitle: { en: 'End this adventure?', es: '¿Terminar esta aventura?' },
  endConfirmBody: {
    en: 'Bring the story to a close and take home a comic of the night.',
    es: 'Dadle un final a la historia y llevaos un cómic de esta noche.',
  },
  cancel: { en: 'Cancel', es: 'Cancelar' },
  confirmEnd: { en: 'End adventure', es: 'Terminar aventura' },
  working: { en: 'Working…', es: 'Trabajando…' },
  choiceSafe: { en: 'Choice', es: 'Opción' },
  choiceRisky: { en: 'Risky · d20 ≥ 11', es: 'Arriesgada · d20 ≥ 11' },
  outcomeSuccess: { en: 'Your risk paid off', es: 'Vuestra audacia da resultado' },
  outcomeSetback: { en: 'A setback, and a new way forward', es: 'Un contratiempo y otro camino' },
  outcomeAlly: { en: 'You earned an ally', es: 'Habéis ganado un aliado' },
  outcomeTrust: { en: 'Trust opened a path', es: 'La confianza abre un camino' },
  nameTooLong: { en: 'Keep each player name to 32 characters.', es: 'Cada nombre debe tener como máximo 32 caracteres.' },
  stateChanged: { en: 'The story moved on another screen. The latest chapter is ready.', es: 'La historia avanzó en otra pantalla. Ya tienes el último capítulo.' },
  chapterOf: { en: 'Chapter {n} of {max}', es: 'Capítulo {n} de {max}' },
  rollResult: { en: 'd{sides}: {total}', es: 'd{sides}: {total}' },
  rollSuccess: { en: 'Success', es: 'Éxito' },
  rollFail: { en: 'Miss', es: 'Fallo' },
  rollUsed: { en: 'used', es: 'usada' },
  linkCopied: { en: 'TV link copied', es: 'Enlace de TV copiado' },
  linkCopyFailed: { en: 'Could not copy the link', es: 'No se pudo copiar el enlace' },
  speechUnsupported: {
    en: 'Voice input is not supported in this browser. Type an action instead.',
    es: 'La entrada de voz no está disponible en este navegador. Escribe una acción.',
  },
  speechError: {
    en: 'Microphone error. Check permissions or type your action.',
    es: 'Error del micrófono. Revisa permisos o escribe tu acción.',
  },
  ttsUnsupported: {
    en: 'Narration is not supported in this browser.',
    es: 'La narración no está disponible en este navegador.',
  },
  needPlayers: {
    en: 'Add at least one player name.',
    es: 'Añade al menos un nombre de jugador.',
  },
  tooManyPlayers: {
    en: 'Use at most 6 player names.',
    es: 'Usa como máximo 6 nombres.',
  },
  sessionMissing: {
    en: 'That adventure was not found. Start a new one.',
    es: 'No se encontró esa aventura. Empieza una nueva.',
  },
  networkError: {
    en: 'Network error. Check your connection and try again.',
    es: 'Error de red. Revisa la conexión e inténtalo de nuevo.',
  },
  genericError: {
    en: 'Something went wrong. Please try again.',
    es: 'Algo salió mal. Inténtalo de nuevo.',
  },
  pngExporting: { en: 'Preparing PNG…', es: 'Preparando PNG…' },
  pngFailed: {
    en: 'Download failed. Try again.',
    es: 'La descarga falló. Inténtalo de nuevo.',
  },
  endedBanner: {
    en: 'Adventure complete — open the comic keepsake.',
    es: 'Aventura terminada — abre el cómic como recuerdo.',
  },
  choicePrefix: { en: 'CHOICE', es: 'DECISIÓN' },
  viewingPast: {
    en: 'Viewing a past chapter. Return to the latest to choose.',
    es: 'Viendo un capítulo pasado. Vuelve al último para elegir.',
  },
} as const;

export type MsgKey = keyof typeof dict;

export function t(lang: Language, key: MsgKey, vars?: Record<string, string | number>): string {
  let out: string = dict[key][lang] ?? dict[key].en;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      out = out.replaceAll(`{${k}}`, String(v));
    }
  }
  return out;
}

export function applyStaticI18n(lang: Language): void {
  document.documentElement.lang = lang;
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach(el => {
    const key = el.dataset.i18n as MsgKey | undefined;
    if (key && key in dict) el.textContent = t(lang, key);
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-placeholder]').forEach(el => {
    const key = el.dataset.i18nPlaceholder as MsgKey | undefined;
    if (key && key in dict && 'placeholder' in el) {
      (el as HTMLInputElement).placeholder = t(lang, key);
    }
  });
  document.querySelectorAll<HTMLElement>('[data-i18n-aria]').forEach(el => {
    const key = el.dataset.i18nAria as MsgKey | undefined;
    if (key && key in dict) el.setAttribute('aria-label', t(lang, key));
  });
}
