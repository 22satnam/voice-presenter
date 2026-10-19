import { speechAudio } from './api';

function splitText(text: string, limit = 175): string[] {
  const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
  const parts: string[] = [];
  let current = '';
  for (const sentence of sentences) {
    const words = sentence.trim().split(/\s+/);
    for (const word of words) {
      if (current && current.length + word.length + 1 > limit) {
        parts.push(current);
        current = '';
      }
      current += (current ? ' ' : '') + word;
    }
  }
  if (current) parts.push(current);
  return parts;
}

export class Speaker {
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;
  private useBrowser = false;

  unlock() {
    // Call this directly from the Present / Ask button click.
    const Audio = window.AudioContext;
    if (Audio) {
      this.context ||= new Audio();
      void this.context.resume();
    }
    window.speechSynthesis?.resume();
  }

  stop() {
    try { this.source?.stop(); } catch { /* already stopped */ }
    this.source = null;
    window.speechSynthesis?.cancel();
  }

  async speak(text: string, signal: AbortSignal, onVoiceChange?: (name: string) => void) {
    this.useBrowser = false;
    for (const part of splitText(text)) {
      if (signal.aborted) return;
      if (!this.useBrowser) {
        try {
          const wav = await speechAudio(part, signal);
          await this.playWav(wav, signal);
          onVoiceChange?.('Groq voice');
          continue;
        } catch (err) {
          if (signal.aborted) return;
          this.useBrowser = true;
        }
      }
      onVoiceChange?.('Browser voice');
      await this.browserSpeak(part, signal);
    }
  }

  private async playWav(wav: ArrayBuffer, signal: AbortSignal) {
    const ctx = this.context;
    if (!ctx) throw new Error('Audio is unavailable');
    await ctx.resume();
    const buffer = await ctx.decodeAudioData(wav);
    if (signal.aborted) return;
    return new Promise<void>((resolve, reject) => {
      const source = ctx.createBufferSource();
      this.source = source;
      source.buffer = buffer;
      source.connect(ctx.destination);
      const done = (cancelled: boolean) => {
        signal.removeEventListener('abort', abort);
        if (this.source === source) this.source = null;
        cancelled ? reject(new DOMException('Stopped', 'AbortError')) : resolve();
      };
      const abort = () => { try { source.stop(); } catch { /* already ended */ } };
      source.onended = () => done(signal.aborted);
      signal.addEventListener('abort', abort, { once: true });
      source.start();
    });
  }

  private browserSpeak(text: string, signal: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
      if (!window.speechSynthesis) return reject(new Error('No speech output is available in this browser'));
      const utterance = new SpeechSynthesisUtterance(text);
      const voices = window.speechSynthesis.getVoices().filter(v => v.lang.startsWith('en'));
      utterance.voice = voices.find(v => /Aria|Jenny|Natural|Google US English/i.test(v.name)) || voices[0] || null;
      utterance.rate = 0.98;
      const done = (error?: string) => {
        signal.removeEventListener('abort', abort);
        error ? reject(new Error(error)) : resolve();
      };
      const abort = () => window.speechSynthesis.cancel();
      utterance.onend = () => done(signal.aborted ? 'Stopped' : undefined);
      utterance.onerror = event => done(event.error === 'interrupted' && signal.aborted ? 'Stopped' : `Browser voice failed (${event.error})`);
      signal.addEventListener('abort', abort, { once: true });
      window.speechSynthesis.speak(utterance);
    });
  }
}
