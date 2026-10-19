import type { Deck } from "@/data/decks";

export const API_BASE = (import.meta.env.VITE_API_BASE || "http://localhost:8000").replace(/\/$/, "");
export type Usage = { input_tokens: number; output_tokens: number; provider?: string; model?: string };
export type StreamEvent =
  | { type: "delta"; text: string }
  | { type: "usage"; usage: Usage }
  | { type: "fallback"; provider: string }
  | { type: "error"; message: string }
  | { type: "done"; latency_ms: number };
export type Route = {
  target_slide: number; bullet: number; confidence: number; covered: boolean;
  reason: string; source: string; usage: Usage; latency_ms: number;
  sanitized_question: string; pii_types: string[];
};

export async function request<T>(path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(API_BASE + path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body), signal,
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({}));
    throw new Error(data.detail || `Request failed: ${response.status}`);
  }
  return response.json() as Promise<T>;
}

export async function getDeck(id: string): Promise<Deck> {
  return request<Deck>(`/api/decks/${encodeURIComponent(id)}`);
}

export async function* streamText(path: string, body: unknown, signal: AbortSignal): AsyncGenerator<StreamEvent> {
  const response = await fetch(API_BASE + path, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal,
  });
  if (!response.ok) throw new Error(`Generation failed: ${response.status}`);
  if (!response.body) throw new Error("Streaming is unavailable in this browser");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let index: number;
      while ((index = pending.indexOf("\n\n")) >= 0) {
        const raw = pending.slice(0, index); pending = pending.slice(index + 2);
        for (const line of raw.split("\n")) {
          if (line.startsWith("data: ")) yield JSON.parse(line.slice(6)) as StreamEvent;
        }
      }
    }
  } finally { reader.releaseLock(); }
}

export function telemetry(session_id: string, kind: "interrupt" | "nav" | "error", route: string, payload: Record<string, unknown> = {}): void {
  void request("/api/events", { session_id, kind, route, payload }).catch(() => {});
}
