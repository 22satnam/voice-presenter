export type MicStatus = 'Mic off' | 'Ready' | 'Listening for questions' | 'Listening for interruption';

type ListenOptions = {
  timeoutMs?: number;
  mode?: 'question' | 'barge';
  onSpeechStart?: () => void;
};

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
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false },
    });
    this.context = new AudioContext();
    await this.context.resume();

    const source = this.context.createMediaStreamSource(this.stream);
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 1024;
    source.connect(this.analyser);
    this.onStatus('Ready');
  }

  async listen(signal: AbortSignal, options: ListenOptions = {}): Promise<Blob | null> {
    await this.open();
    if (!this.stream || !this.analyser || signal.aborted) return null;

    const mode = options.mode || 'question';
    const timeoutMs = options.timeoutMs ?? (mode === 'barge' ? 60000 : 6000);
    const minRms = mode === 'barge' ? 0.04 : 0.025;
    const requiredFrames = mode === 'barge' ? 12 : 7;
    const silenceMs = 850;
    const samples = new Float32Array(this.analyser.fftSize);

    let floor = 0.004;
    let loudFrames = 0;
    let confirmed = false;
    let recorder: MediaRecorder | null = null;
    let chunks: Blob[] = [];
    let lastVoice = 0;
    const started = performance.now();

    this.onStatus(mode === 'barge' ? 'Listening for interruption' : 'Listening for questions');

    return new Promise<Blob | null>(resolve => {
      let frame = 0;
      let done = false;

      const stopRecorder = (keep: boolean) => {
        if (!recorder) {
          finish(null);
          return;
        }
        const current = recorder;
        recorder = null;
        current.onstop = () => {
          const blob = new Blob(chunks, { type: current.mimeType });
          finish(keep && blob.size > 1800 ? blob : null);
        };
        if (current.state !== 'inactive') current.stop();
        else finish(null);
      };

      const finish = (blob: Blob | null) => {
        if (done) return;
        done = true;
        cancelAnimationFrame(frame);
        signal.removeEventListener('abort', abort);
        this.onStatus('Ready');
        resolve(blob);
      };

      const abort = () => {
        if (recorder && recorder.state !== 'inactive') {
          recorder.onstop = () => finish(null);
          recorder.stop();
        } else {
          finish(null);
        }
      };
      signal.addEventListener('abort', abort, { once: true });

      const startRecording = () => {
        if (!this.stream || recorder) return;
        const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
          .find(type => MediaRecorder.isTypeSupported(type));
        recorder = mime
          ? new MediaRecorder(this.stream, { mimeType: mime })
          : new MediaRecorder(this.stream);
        chunks = [];
        recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
        recorder.start();
      };

      const tick = () => {
        if (signal.aborted) return abort();

        const now = performance.now();
        this.analyser!.getFloatTimeDomainData(samples);
        let power = 0;
        for (const sample of samples) power += sample * sample;
        const rms = Math.sqrt(power / samples.length);

        if (!confirmed) {
          floor = floor * 0.94 + Math.min(rms, 0.03) * 0.06;
          const threshold = Math.max(minRms, floor * (mode === 'barge' ? 2.8 : 2.1));

          if (rms > threshold) {
            loudFrames++;
          } else {
            loudFrames = Math.max(0, loudFrames - 2);
          }

          if (loudFrames >= requiredFrames) {
            confirmed = true;
            lastVoice = now;
            startRecording();
            options.onSpeechStart?.();
          } else if (now - started >= timeoutMs) {
            return finish(null);
          }
        } else {
          if (rms > Math.max(0.018, floor * 1.5)) lastVoice = now;
          if (now - lastVoice > silenceMs) return stopRecorder(true);
          if (now - started > 15000) return stopRecorder(true);
        }

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
