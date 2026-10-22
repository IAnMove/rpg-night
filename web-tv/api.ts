import type { AppConfig, Session, StartInput, World } from '../shared/types.js';

export class ApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'ApiError';
  }
}

async function readError(res: Response): Promise<string> {
  try {
    const body = await res.json() as { error?: string };
    if (body?.error) return body.error;
  } catch { /* ignore */ }
  return `HTTP ${res.status}`;
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError('NETWORK', 0);
  }
  if (!res.ok) throw new ApiError(await readError(res), res.status);
  return res.json() as Promise<T>;
}

export function getConfig(): Promise<AppConfig> {
  return request<AppConfig>('/api/config');
}

export function createSession(input: StartInput): Promise<Session> {
  return request<Session>('/api/sessions', { method: 'POST', body: JSON.stringify(input) });
}

export function getSession(id: string): Promise<Session> {
  return request<Session>(`/api/sessions/${encodeURIComponent(id)}`);
}

export function postAction(id: string, action: string, choiceId?: string): Promise<Session> {
  const body: { action: string; choiceId?: string } = { action };
  if (choiceId) body.choiceId = choiceId;
  return request<Session>(`/api/sessions/${encodeURIComponent(id)}/actions`, {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export function postDice(id: string, sides = 20, count = 1, modifier = 0): Promise<Session> {
  return request<Session>(`/api/sessions/${encodeURIComponent(id)}/dice`, {
    method: 'POST',
    body: JSON.stringify({ sides, count, modifier }),
  });
}

export function postEnd(id: string): Promise<Session> {
  return request<Session>(`/api/sessions/${encodeURIComponent(id)}/end`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
}

export function comicSvgUrl(id: string): string {
  return `/api/sessions/${encodeURIComponent(id)}/comic.svg`;
}

export function previewUrl(world: World): string {
  return `/api/preview/${world}.svg`;
}

export type SseHandlers = {
  onSession: (session: Session) => void;
  onStatus: (status: 'connecting' | 'live' | 'reconnecting' | 'offline') => void;
};

/** SSE client with automatic reconnect. Call close() to stop permanently. */
export function connectSessionEvents(id: string, handlers: SseHandlers): { close: () => void } {
  let closed = false;
  let source: EventSource | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let attempt = 0;

  const clearRetry = () => {
    if (retryTimer != null) {
      clearTimeout(retryTimer);
      retryTimer = null;
    }
  };

  const open = () => {
    if (closed) return;
    handlers.onStatus(attempt === 0 ? 'connecting' : 'reconnecting');
    source = new EventSource(`/api/sessions/${encodeURIComponent(id)}/events`);
    source.addEventListener('session', (ev: MessageEvent<string>) => {
      try {
        const session = JSON.parse(ev.data) as Session;
        handlers.onSession(session);
      } catch { /* ignore malformed */ }
    });
    source.onopen = () => {
      attempt = 0;
      handlers.onStatus('live');
    };
    source.onerror = () => {
      source?.close();
      source = null;
      if (closed) return;
      handlers.onStatus('reconnecting');
      attempt += 1;
      const delay = Math.min(1000 * 2 ** Math.min(attempt, 4), 15000);
      clearRetry();
      retryTimer = setTimeout(open, delay);
    };
  };

  open();

  return {
    close() {
      closed = true;
      clearRetry();
      source?.close();
      source = null;
      handlers.onStatus('offline');
    },
  };
}
