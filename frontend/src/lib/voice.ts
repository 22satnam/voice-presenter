import { API_BASE } from "./api";

// VAD produces 16 kHz mono float32 samples; wrap them in a standard PCM WAV.
export function wavFromFloat(samples: Float32Array): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const write = (p: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(p + i, s.charCodeAt(i)); };
  write(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true);
  write(8, "WAVE"); write(12, "fmt "); view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, 16000, true); view.setUint32(28, 32000, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true);
  write(36, "data"); view.setUint32(40, samples.length * 2, true);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(44 + i * 2, v < 0 ? v * 32768 : v * 32767, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}

export async function transcribe(audio: Blob, session: string, signal: AbortSignal): Promise<string> {
  const form = new FormData(); form.append("file", audio, "speech.wav");
  const r = await fetch(API_BASE + "/api/stt", { method: "POST", body: form, signal, headers: { "X-Session-Id": session } });
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).detail || "Transcription failed");
  const data = await r.json();
  return data.text as string;
}

export class Speaker {
  private audio: HTMLAudioElement | null = null;
  private objectUrl: string | null = null;

  cancel() {
    if (this.audio) { this.audio.pause(); this.audio.src = ""; this.audio = null; }
    if (this.objectUrl) { URL.revokeObjectURL(this.objectUrl); this.objectUrl = null; }
    window.speechSynthesis?.cancel();
  }

  async speak(sentence: string, session: string, signal: AbortSignal): Promise<boolean> {
    if (signal.aborted || !sentence.trim()) return false;
    // Orpheus accepts at most 200 characters, so the caller must split long sentences.
    try {
      const response = await fetch(API_BASE + "/api/tts", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ session_id: session, text: sentence.slice(0, 200) }), signal,
      });
      if (!response.ok) throw new Error("TTS provider is unavailable");
      const blob = await response.blob();
      if (signal.aborted) return false;
      this.objectUrl = URL.createObjectURL(blob);
      const audio = new Audio(this.objectUrl);
      this.audio = audio;
      return await new Promise<boolean>((resolve) => {
        let finished = false;
        const finish = (heard: boolean) => {
          if (finished) return;
          finished = true; signal.removeEventListener("abort", stop);
          audio.pause(); URL.revokeObjectURL(this.objectUrl || ""); this.objectUrl = null;
          if (this.audio === audio) this.audio = null;
          resolve(heard);
        };
        const stop = () => finish(false);
        signal.addEventListener("abort", stop, { once: true });
        audio.onended = () => finish(true);
        audio.onerror = () => finish(false);
        void audio.play().catch(() => finish(false));
      });
    } catch (error) {
      if (signal.aborted || (error instanceof DOMException && error.name === "AbortError")) return false;
      // Guaranteed-free browser fallback; actual voice availability varies by platform.
      return this.browserSpeak(sentence, signal);
    }
  }

  private browserSpeak(sentence: string, signal: AbortSignal): Promise<boolean> {
    return new Promise((resolve) => {
      if (!('speechSynthesis' in window) || signal.aborted) return resolve(false);
      const msg = new SpeechSynthesisUtterance(sentence); msg.rate = 1.06;
      let finished = false;
      const finish = (heard: boolean) => {
        if (finished) return;
        finished = true; signal.removeEventListener("abort", stop); resolve(heard);
      };
      const stop = () => { window.speechSynthesis.cancel(); finish(false); };
      signal.addEventListener("abort", stop, { once: true });
      msg.onend = () => finish(true);
      msg.onerror = () => finish(false);
      window.speechSynthesis.speak(msg);
    });
  }
}

export function segmentSentences(text: string): { sentences: string[]; remainder: string } {
  const sentences: string[] = [];
  let pending = text;
  for (;;) {
    const match = pending.match(/^([\s\S]*?[.!?])(?=\s|$)/);
    if (match) {
      let complete = match[1].trim();
      while (complete.length > 185) {
        const cut = complete.lastIndexOf(" ", 185);
        const n = cut > 60 ? cut : 185;
        sentences.push(complete.slice(0, n).trim());
        complete = complete.slice(n).trimStart();
      }
      if (complete) sentences.push(complete);
      pending = pending.slice(match[0].length).trimStart();
      continue;
    }
    if (pending.length > 185) {
      const cut = pending.lastIndexOf(' ', 185);
      const n = cut > 60 ? cut : 185;
      sentences.push(pending.slice(0, n).trim()); pending = pending.slice(n).trimStart(); continue;
    }
    break;
  }
  return { sentences, remainder: pending };
}
