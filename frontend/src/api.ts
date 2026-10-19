/// <reference types="vite/client" />
const API = (import.meta.env.VITE_API_BASE || 'http://localhost:8000').replace(/\/$/, '');

export type Slide = { title: string; text: string; notes: string; image: string };
export type Deck = { id: string; title: string; description: string; slides: Slide[] };
export type DeckItem = { id: string; title: string; description: string; slide_count: number; cover: string };
export type Answer = { slide_index: number; slide_number: number; answer: string; provider: string };
export type PreparedNarration = {
  deck_id: string;
  provider: string;
  slides: { slide_index: number; text: string }[];
};

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

export async function deepgramToken(signal?: AbortSignal): Promise<string> {
  const response = await fetch(API + '/api/deepgram-token', { method: 'POST', signal });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || 'Deepgram Flux is unavailable');
  }
  return (await response.json()).access_token as string;
}

export async function transcribeAudio(audio: Blob, signal: AbortSignal): Promise<string> {
  const format = audio.type.includes('mp4') ? 'question.m4a' : 'question.webm';
  const data = new FormData();
  data.append('file', audio, format);
  const response = await fetch(API + '/api/stt', { method: 'POST', body: data, signal });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || 'Could not transcribe speech');
  }
  return (await response.json()).text as string;
}

export async function speechAudio(text: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const response = await fetch(API + '/api/tts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
    signal,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || 'Gemini voice is unavailable');
  }
  return response.arrayBuffer();
}

export async function streamAnswer(
  data: unknown,
  signal: AbortSignal,
  handlers: {
    onSlide: (slideIndex: number) => void;
    onText: (text: string) => void;
  },
): Promise<void> {
  const response = await fetch(API + '/api/ask-stream', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
    signal,
  });
  if (!response.ok || !response.body) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || 'Could not answer');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    while (true) {
      const end = buffer.indexOf('\n\n');
      if (end < 0) break;
      const event = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const dataLine = event.split('\n').find(line => line.startsWith('data: '));
      if (!dataLine) continue;
      const payload = JSON.parse(dataLine.slice(6));
      if (payload.type === 'slide') handlers.onSlide(payload.slide_index);
      else if (payload.type === 'text') handlers.onText(payload.text);
      else if (payload.type === 'error') throw new Error(payload.message);
    }
  }
}
