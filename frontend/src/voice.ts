import { speechAudio } from './api';

export class Speaker {
  private context: AudioContext | null = null;
  private source: AudioBufferSourceNode | null = null;

  unlock() {
    this.context ||= new AudioContext();
    void this.context.resume();
  }

  stop() {
    try { this.source?.stop(); } catch { /* Playback already ended. */ }
    this.source = null;
  }

  async speak(text: string, signal: AbortSignal, onVoiceChange?: (voice: string) => void) {
    if (signal.aborted) return;
    this.unlock();
    const audio = await speechAudio(text, signal);
    if (signal.aborted) return;
    const context = this.context!;
    const buffer = await context.decodeAudioData(audio);
    await context.resume();
    if (signal.aborted) return;
    onVoiceChange?.('Gemini voice');

    await new Promise<void>((resolve, reject) => {
      const source = context.createBufferSource();
      this.source = source;
      source.buffer = buffer;
      source.connect(context.destination);
      const finish = () => {
        signal.removeEventListener('abort', cancel);
        if (this.source === source) this.source = null;
        signal.aborted ? reject(new DOMException('Stopped', 'AbortError')) : resolve();
      };
      const cancel = () => { try { source.stop(); } catch { /* Already stopped. */ } };
      signal.addEventListener('abort', cancel, { once: true });
      source.onended = finish;
      source.start();
    });
  }
}
