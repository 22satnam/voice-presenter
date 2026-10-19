/// <reference types="vite/client" />

const API = (import.meta.env.VITE_API_BASE || "http://localhost:8000").replace(/\/$/, "");

export type Slide = {
  title: string;
  text: string;
  notes: string;
  image: string;
};

export type Deck = {
  id: string;
  title: string;
  description: string;
  slides: Slide[];
};

export type DeckItem = {
  id: string;
  title: string;
  description: string;
  slide_count: number;
  cover: string;
};

export async function api<T>(path: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(API + path, { signal });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export async function createLiveToken(signal?: AbortSignal) {
  const response = await fetch(API + "/api/live-token", {
    method: "POST",
    signal,
  });
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(error.detail || "Could not start Gemini Live");
  }
  return response.json() as Promise<{ token: string; model: string }>;
}
