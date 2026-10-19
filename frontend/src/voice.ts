import { speechAudio } from './api';

export type PlayResult = { completed: boolean; offset: number };

type ActivePlayback = {
  source: AudioBufferSourceNode;
  signal: AbortSignal;
  startedAt: number;
  offset: number;
  paused: boolean;
  pausedAt: number;
  cancelled: boolean;
};

export class Speaker {
  private context: AudioContext | null = null;
  private active: ActivePlayback | null = null;

  unlock() {
    this.context ||= new AudioContext();
    void this.context.resume();
  }

  async decode(audio: ArrayBuffer) {
    this.unlock();
    return this.context!.decodeAudioData(audio.slice(0));
  }

  async prepare(text: string, signal?: AbortSignal) {
    const audio = await speechAudio(text, signal);
    return this.decode(audio);
  }

  pause() {
    const state = this.active;
    const context = this.context;
    if (!state || !context) return 0;

    const elapsed = Math.max(0, context.currentTime - state.startedAt);
    state.pausedAt = Math.min(state.source.buffer?.duration || Infinity, state.offset + elapsed);
    state.paused = true;
    try { state.source.stop(); } catch { /* Source already ended. */ }
    return state.pausedAt;
  }

  stop() {
    if (!this.active) return;
    this.active.cancelled = true;
    try { this.active.source.stop(); } catch { /* Source already ended. */ }
  }

  async play(
    buffer: AudioBuffer,
    signal: AbortSignal,
    offset = 0,
    onVoiceChange?: (voice: string) => void,
  ): Promise<PlayResult> {
    if (signal.aborted) throw new DOMException('Stopped', 'AbortError');

    this.unlock();
    const context = this.context!;
    await context.resume();
    const safeOffset = Math.max(0, Math.min(offset, Math.max(0, buffer.duration - 0.01)));
    onVoiceChange?.('Gemini voice');

    return new Promise<PlayResult>((resolve, reject) => {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);

      const state: ActivePlayback = {
        source,
        signal,
        startedAt: context.currentTime,
        offset: safeOffset,
        paused: false,
        pausedAt: safeOffset,
        cancelled: false,
      };
      this.active = state;

      const cancel = () => {
        state.cancelled = true;
        try { source.stop(); } catch { /* Source already ended. */ }
      };

      const finish = () => {
        signal.removeEventListener('abort', cancel);
        if (this.active === state) this.active = null;

        if (signal.aborted || state.cancelled) {
          reject(new DOMException('Stopped', 'AbortError'));
        } else if (state.paused) {
          resolve({ completed: false, offset: state.pausedAt });
        } else {
          resolve({ completed: true, offset: buffer.duration });
        }
      };

      signal.addEventListener('abort', cancel, { once: true });
      source.onended = finish;
      source.start(0, safeOffset);
    });
  }

  async speak(text: string, signal: AbortSignal, onVoiceChange?: (voice: string) => void) {
    const buffer = await this.prepare(text, signal);
    return this.play(buffer, signal, 0, onVoiceChange);
  }
}
