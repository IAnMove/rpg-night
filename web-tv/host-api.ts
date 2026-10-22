import { HostPublicStateSchema, HostResponseSchema, type HostPublicState, type HostResponse, type PlayerTurnRequest } from '../shared/host-schema.js';
import type { Language } from '../shared/types.js';

export class HostApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = 'HostApiError';
  }
}

async function request(url: string, init?: RequestInit): Promise<HostResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new HostApiError('NETWORK', 0);
  }
  let data: unknown;
  try { data = await response.json(); }
  catch { throw new HostApiError(`Invalid host response (HTTP ${response.status})`, response.status); }
  if (!response.ok) {
    const detail = data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
      ? data.error
      : `HTTP ${response.status}`;
    throw new HostApiError(detail, response.status);
  }
  return HostResponseSchema.parse(data);
}

export function createHostConversation(locale: Language, sessionId?: string): Promise<HostResponse> {
  return request('/api/host/conversations', {
    method: 'POST',
    body: JSON.stringify({ request_id: crypto.randomUUID(), locale, ...(sessionId ? { session_id: sessionId } : {}) }),
  });
}

export function restoreHostConversation(locale: Language, conversationId: string): Promise<HostResponse> {
  return request('/api/host/conversations', {
    method: 'POST', body: JSON.stringify({ request_id: conversationId, locale }),
  });
}

export function getPendingHostOperation(conversationId: string): Promise<HostResponse> {
  return request(`/api/host/conversations/${encodeURIComponent(conversationId)}/operation`);
}

export function sendHostTurn(conversationId: string, input: PlayerTurnRequest): Promise<HostResponse> {
  return request(`/api/host/conversations/${encodeURIComponent(conversationId)}/turns`, {
    method: 'POST', body: JSON.stringify(input),
  });
}

export function controlHostConversation(
  conversationId: string,
  control: 'pause' | 'resume',
  expectedRevision?: number,
): Promise<HostResponse> {
  return request(`/api/host/conversations/${encodeURIComponent(conversationId)}/${control}`, {
    method: 'POST',
    body: JSON.stringify({ request_id: crypto.randomUUID(), ...(expectedRevision === undefined ? {} : { expected_revision: expectedRevision }) }),
  });
}

export async function getHostPublicState(conversationId: string): Promise<HostPublicState> {
  const response = await fetch(`/api/host/conversations/${encodeURIComponent(conversationId)}/tv`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new HostApiError(response.status === 404 ? 'NOT_FOUND' : `HTTP ${response.status}`, response.status);
  return HostPublicStateSchema.parse(await response.json());
}

export function connectHostPublicState(conversationId: string, onState: (state: HostPublicState) => void, onDisconnect: () => void): { close: () => void } {
  const source = new EventSource(`/api/host/conversations/${encodeURIComponent(conversationId)}/events`);
  source.addEventListener('public-state', (event) => {
    try { onState(HostPublicStateSchema.parse(JSON.parse((event as MessageEvent<string>).data))); }
    catch { onDisconnect(); }
  });
  source.addEventListener('error', onDisconnect);
  return { close: () => source.close() };
}

export function hostComicSvgUrl(conversationId: string): string {
  return `/api/host/conversations/${encodeURIComponent(conversationId)}/comic.svg`;
}
