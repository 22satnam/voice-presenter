type Status = 'Listening' | 'Processing' | 'Mic paused' | 'Mic off';

export class Listener {
  private stream: MediaStream | null = null;
  private context: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private recorder: MediaRecorder | null = null;
  private frame = 0;
  private recording = false;
  private processing = false;
  private paused = false;
  private running = false;
  private version = 0;
  private startAt = 0;
  private lastVoice = 0;

  constructor(
    private onAudio: (audio: Blob) => Promise<void>,
    private onStatus: (status: Status) => void,
    private onError: (message: string) => void,
  ) {}

  async start() {
    if (this.running) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      throw new Error('Microphone recording is unavailable in this browser. Use HTTPS and Chrome or Edge.');
    }
    const version = ++this.version;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    if (version !== this.version) {
      stream.getTracks().forEach(track => track.stop());
      return;
    }
    this.stream = stream;
    this.context = new AudioContext();
    void this.context.resume().catch(() => this.onError('Microphone audio is paused by the browser. Try turning the mic on again.'));
    const source = this.context.createMediaStreamSource(stream);
    this.analyser = this.context.createAnalyser();
    this.analyser.fftSize = 1024;
    source.connect(this.analyser);
    this.running = true;
    this.onStatus('Listening');
    this.tick();
  }

  pause(value: boolean) {
    this.paused = value;
    if (value && this.recording) this.finish(true);
    if (this.running) this.onStatus(value ? 'Mic paused' : (this.processing ? 'Processing' : 'Listening'));
  }

  stop() {
    this.version++;
    this.running = false;
    this.paused = false;
    cancelAnimationFrame(this.frame);
    this.finish(true);
    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;
    void this.context?.close();
    this.context = null;
    this.analyser = null;
    this.onStatus('Mic off');
  }

  private tick() {
    if (!this.running || !this.analyser) return;
    this.frame = requestAnimationFrame(() => this.tick());
    if (this.paused || this.processing) return;

    const samples = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(samples);
    let power = 0;
    for (const sample of samples) power += sample * sample;
    const loud = Math.sqrt(power / samples.length) > 0.018;
    const now = performance.now();

    if (loud && !this.recording) this.begin(now);
    if (!this.recording) return;
    if (loud) this.lastVoice = now;
    if ((now - this.lastVoice > 1100 && now - this.startAt > 550) || now - this.startAt > 14000) {
      this.finish(false);
    }
  }

  private begin(now: number) {
    if (!this.stream) return;
    const type = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm']
      .find(mime => MediaRecorder.isTypeSupported(mime));
    const recorder = type ? new MediaRecorder(this.stream, { mimeType: type }) : new MediaRecorder(this.stream);
    const chunks: Blob[] = [];
    const version = this.version;
    recorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    recorder.onstop = async () => {
      if (version !== this.version || this.paused || !this.running) return;
      const audio = new Blob(chunks, { type: recorder.mimeType });
      if (audio.size < 1800) return;
      this.processing = true;
      this.onStatus('Processing');
      try {
        await this.onAudio(audio);
      } catch (error) {
        if (version === this.version) this.onError(error instanceof Error ? error.message : 'Transcription failed');
      } finally {
        this.processing = false;
        if (this.running && !this.paused) this.onStatus('Listening');
      }
    };
    recorder.start();
    this.recorder = recorder;
    this.startAt = now;
    this.lastVoice = now;
    this.recording = true;
  }

  private finish(discard: boolean) {
    if (!this.recording || !this.recorder) return;
    const recorder = this.recorder;
    this.recorder = null;
    this.recording = false;
    if (discard) recorder.onstop = null;
    if (recorder.state !== 'inactive') recorder.stop();
  }
}
