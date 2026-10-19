import { speechAudio } from './api';

export type PlayResult = {
  status: 'done' | 'interrupted';
  offset: number;
};

type Playback = {
  source: AudioBufferSourceNode;
  startedAt: number;
  offset: number;
  interrupted: boolean;
  interruptedAt: number;
  cancelled: boolean;
};

export class Speaker {
  private context: AudioContext | null = null;
  private gain: GainNode | null = null;
  private active: Playback | null = null;

  unlock() {
    if (!this.context) {
      this.context = new AudioContext();
      this.gain = this.context.createGain();
      this.gain.connect(this.context.destination);
    }
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

  duck() {
    if (!this.context || !this.gain) return;
    const now = this.context.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(this.gain.gain.value, now);
    this.gain.gain.linearRampToValueAtTime(0.12, now + 0.05);
  }

  restore() {
    if (!this.context || !this.gain) return;
    const now = this.context.currentTime;
    this.gain.gain.cancelScheduledValues(now);
    this.gain.gain.setValueAtTime(this.gain.gain.value, now);
    this.gain.gain.linearRampToValueAtTime(1, now + 0.08);
  }

  interrupt() {
    const state = this.active;
    const context = this.context;
    if (!state || !context) return null;

    const elapsed = Math.max(0, context.currentTime - state.startedAt);
    state.interruptedAt = state.offset + elapsed;
    state.interrupted = true;
    try { state.source.stop(); } catch { /* already ended */ }
    return state.interruptedAt;
  }

  stop() {
    const state = this.active;
    if (!state) return;
    state.cancelled = true;
    try { state.source.stop(); } catch { /* already ended */ }
  }

  async play(
    buffer: AudioBuffer,
    signal: AbortSignal,
    onVoiceChange?: (voice: string) => void,
    offset = 0,
  ): Promise<PlayResult> {
    if (signal.aborted) throw new DOMException('Stopped', 'AbortError');

    this.unlock();
    this.restore();
    const context = this.context!;
    await context.resume();

    const safeOffset = Math.max(0, Math.min(offset, Math.max(0, buffer.duration - 0.02)));
    onVoiceChange?.('Gemini voice');

    return new Promise<PlayResult>((resolve, reject) => {
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(this.gain!);

      const state: Playback = {
        source,
        startedAt: context.currentTime,
        offset: safeOffset,
        interrupted: false,
        interruptedAt: safeOffset,
        cancelled: false,
      };
      this.active = state;

      const abort = () => {
        state.cancelled = true;
        try { source.stop(); } catch { /* already ended */ }
      };

      source.onended = () => {
        signal.removeEventListener('abort', abort);
        if (this.active === state) this.active = null;
        this.restore();

        if (signal.aborted || state.cancelled) {
          reject(new DOMException('Stopped', 'AbortError'));
        } else if (state.interrupted) {
          resolve({ status: 'interrupted', offset: state.interruptedAt });
        } else {
          resolve({ status: 'done', offset: buffer.duration });
        }
      };

      signal.addEventListener('abort', abort, { once: true });
      source.start(0, safeOffset);
    });
  }
}
