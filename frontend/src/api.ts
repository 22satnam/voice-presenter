const API = (import.meta.env.VITE_API_BASE || 'http://localhost:8000').replace(/\/$/, '');

export type Slide = { title: string; text: string; notes: string; image: string };
export type Deck = { id: string; title: string; description: string; slides: Slide[] };
export type DeckItem = { id: string; title: string; description: string; slide_count: number; cover: string };
export type Answer = { slide_index: number; slide_number: number; answer: string; provider: string };

export async function api<T>(path: string, data?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(API + path, {
    method: data === undefined ? 'GET' : 'POST',
    headers: data === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
    signal,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export async function speechAudio(text: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(API + '/api/tts', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }), signal,
  });
  if (!response.ok) throw new Error('Speech service unavailable');
  return response.arrayBuffer();
}
