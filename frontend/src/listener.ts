export type MicStatus = 'Mic off' | 'Ready' | 'Listening for questions';

export class Listener {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;

  constructor(private onStatus: (status: MicStatus) => void) {}

  async open() {
    if (this.stream) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      throw new Error('Microphone recording is unavailable in this browser.');
    }

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    this.context = new AudioContext();
    await this.context.resume();
    const source = this.context.createMediaStreamSource(this.stream);
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 1024;
    source.connect(this.analyser);
    this.onStatus('Ready');
  }

  async listenOnce(signal: AbortSignal, waitMs = 5000): Promise<Blob | null> {
    await this.open();
    if (!this.stream || !this.analyser || signal.aborted) return null;

    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
      .find(type => MediaRecorder.isTypeSupported(type));
    const recorder = mime ? new MediaRecorder(this.stream, { mimeType: mime }) : new MediaRecorder(this.stream);
    const chunks: Blob[] = [];
    const samples = new Float32Array(this.analyser.fftSize);
    const started = performance.now();
    let lastVoice = 0;
    let loudFrames = 0;
    let heardVoice = false;

    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.start();
    this.onStatus('Listening for questions');

    return new Promise<Blob | null>(resolve => {
      let frame = 0;
      let finished = false;

      const finish = (keep: boolean) => {
        if (finished) return;
        finished = true;
        cancelAnimationFrame(frame);
        signal.removeEventListener('abort', abort);
        recorder.onstop = () => {
          this.onStatus('Ready');
          const blob = new Blob(chunks, { type: recorder.mimeType });
          resolve(keep && blob.size > 1800 ? blob : null);
        };
        if (recorder.state !== 'inactive') recorder.stop();
        else resolve(null);
      };

      const abort = () => finish(false);
      signal.addEventListener('abort', abort, { once: true });

      const tick = () => {
        if (signal.aborted) return finish(false);
        const now = performance.now();
        this.analyser!.getFloatTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += sample * sample;
        const rms = Math.sqrt(sum / samples.length);

        if (rms > 0.03) {
          loudFrames++;
          if (loudFrames >= 8) {
            heardVoice = true;
            lastVoice = now;
          }
        } else {
          loudFrames = Math.max(0, loudFrames - 1);
        }

        if (heardVoice && now - lastVoice > 950) return finish(true);
        if (!heardVoice && now - started > waitMs) return finish(false);
        if (heardVoice && now - started > 14000) return finish(true);
        frame = requestAnimationFrame(tick);
      };

      frame = requestAnimationFrame(tick);
    });
  }

  close() {
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    void this.context?.close();
    this.context = null;
    this.analyser = null;
    this.onStatus('Mic off');
  }
}
