import { DeepgramClient } from '@deepgram/sdk';
import { MicVAD } from '@ricky0123/vad-web';
import { deepgramToken, transcribeAudio } from './api';

export type VoiceStatus =
  | 'Mic off'
  | 'Ready'
  | 'User speaking'
  | 'Flux'
  | 'Transcribing';

export type VoiceCallbacks = {
  onStatus: (status: VoiceStatus) => void;
  onSpeechStart: () => void;
  onSpeechConfirmed: () => void;
  onSpeechMisfire: () => void;
  onEagerEnd: (transcript: string) => void;
  onTurnResumed: () => void;
  onFinal: (transcript: string) => void;
};

type FluxConnection = Awaited<ReturnType<DeepgramClient['listen']['v2']['connect']>>;

export class RealtimeVoice {
  private stream: MediaStream | null = null;
  private vad: MicVAD | null = null;
  private recorder: MediaRecorder | null = null;
  private flux: FluxConnection | null = null;
  private ring: Blob[] = [];
  private utterance: Blob[] = [];
  private sentChunks = 0;
  private speechActive = false;
  private stopped = true;
  private fluxOpening: Promise<void> | null = null;
  private fallbackAbort: AbortController | null = null;

  constructor(private callbacks: VoiceCallbacks) {}

  async start() {
    if (!this.stopped) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      throw new Error('Microphone recording is unavailable in this browser.');
    }

    this.stopped = false;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      },
    });

    await this.startVad(this.stream);
    this.startRecorder(this.stream);
    this.vad?.start();
    this.callbacks.onStatus('Ready');
  }

  stop() {
    this.stopped = true;
    this.fallbackAbort?.abort();
    this.fallbackAbort = null;

    try { this.recorder?.stop(); } catch { /* already stopped */ }
    this.recorder = null;

    try { this.flux?.sendCloseStream(); } catch { /* no active Flux turn */ }
    try { this.flux?.close(); } catch { /* already closed */ }
    this.flux = null;
    this.fluxOpening = null;

    this.vad?.pause();
    this.vad = null;

    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;

    this.ring = [];
    this.utterance = [];
    this.sentChunks = 0;
    this.speechActive = false;
    this.callbacks.onStatus('Mic off');
  }

  private startRecorder(stream: MediaStream) {
    const mime = ['audio/webm;codecs=opus', 'audio/webm']
      .find(type => MediaRecorder.isTypeSupported(type));
    this.recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);

    this.recorder.ondataavailable = event => {
      if (!event.data.size) return;

      this.ring.push(event.data);
      if (this.ring.length > 5) this.ring.shift();

      if (!this.speechActive) return;
      this.utterance.push(event.data);
      this.flushFluxChunks();
    };

    // Flux recommends ~80 ms chunks.
    this.recorder.start(80);
  }

  private async startVad(stream: MediaStream) {
    this.vad = await MicVAD.new({
      model: 'v6',
      baseAssetPath: 'https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.31/dist/',
      onnxWASMBasePath: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/',
      positiveSpeechThreshold: 0.65,
      negativeSpeechThreshold: 0.42,
      minSpeechMs: 300,
      redemptionMs: 350,
      preSpeechPadMs: 160,
      getStream: async () => stream,
      pauseStream: async () => {},
      resumeStream: async () => stream,
      onSpeechStart: () => {
        if (this.stopped) return;
        this.speechActive = true;
        this.utterance = [...this.ring];
        this.sentChunks = 0;
        this.callbacks.onStatus('User speaking');
        this.callbacks.onSpeechStart();
        this.fluxOpening = this.openFluxTurn().catch(() => {
          this.flux = null;
        });
      },
      onSpeechRealStart: () => {
        if (!this.stopped) this.callbacks.onSpeechConfirmed();
      },
      onVADMisfire: () => {
        this.speechActive = false;
        this.utterance = [];
        this.sentChunks = 0;
        this.closeFluxTurn();
        if (!this.stopped) {
          this.callbacks.onStatus('Ready');
          this.callbacks.onSpeechMisfire();
        }
      },
      onSpeechEnd: () => {
        if (this.stopped) return;
        this.speechActive = false;
        void this.finishTurn();
      },
    });
  }

  private async openFluxTurn() {
    const token = await deepgramToken();
    if (this.stopped || !this.speechActive) return;

    const client = new DeepgramClient({ accessToken: token });
    const connection = await client.listen.v2.connect({
      model: 'flux-general-en',
      eager_eot_threshold: '0.6',
      eot_threshold: '0.8',
      eot_timeout_ms: '3500',
      shouldReconnect: () => false,
    });

    connection.on('message', message => {
      if (message.type !== 'TurnInfo') return;
      const transcript = (message.transcript || '').trim();

      if (message.event === 'StartOfTurn') {
        this.callbacks.onStatus('Flux');
      } else if (message.event === 'EagerEndOfTurn' && transcript) {
        this.callbacks.onEagerEnd(transcript);
      } else if (message.event === 'TurnResumed') {
        this.callbacks.onTurnResumed();
      } else if (message.event === 'EndOfTurn' && transcript) {
        this.callbacks.onFinal(transcript);
        this.closeFluxTurn();
        if (!this.stopped) this.callbacks.onStatus('Ready');
      }
    });

    connection.on('error', () => {
      this.flux = null;
    });

    connection.connect();
    await connection.waitForOpen();

    if (this.stopped || !this.speechActive) {
      connection.sendCloseStream();
      connection.close();
      return;
    }

    this.flux = connection;
    this.callbacks.onStatus('Flux');
    this.flushFluxChunks();
  }

  private flushFluxChunks() {
    if (!this.flux) return;
    while (this.sentChunks < this.utterance.length) {
      this.flux.sendMedia(this.utterance[this.sentChunks]);
      this.sentChunks += 1;
    }
  }

  private async finishTurn() {
    try {
      await this.fluxOpening;
    } catch {
      // Fall through to the batch fallback.
    }

    if (this.flux) {
      this.flushFluxChunks();
      try {
        this.flux.sendForceEndTurn();
        return;
      } catch {
        this.closeFluxTurn();
      }
    }

    const chunks = [...this.utterance];
    this.utterance = [];
    this.sentChunks = 0;
    if (chunks.length) await this.batchFallback(chunks);
  }

  private closeFluxTurn() {
    const connection = this.flux;
    this.flux = null;
    this.fluxOpening = null;
    if (!connection) return;
    try { connection.sendCloseStream(); } catch { /* already closing */ }
    try { connection.close(); } catch { /* already closed */ }
  }

  private async batchFallback(chunks: Blob[]) {
    this.fallbackAbort?.abort();
    const controller = new AbortController();
    this.fallbackAbort = controller;
    this.callbacks.onStatus('Transcribing');

    try {
      const type = chunks[0]?.type || 'audio/webm';
      const transcript = (await transcribeAudio(new Blob(chunks, { type }), controller.signal)).trim();
      if (!controller.signal.aborted && transcript) this.callbacks.onFinal(transcript);
    } catch {
      // Typed questions remain available if fallback transcription fails.
    } finally {
      if (this.fallbackAbort === controller) this.fallbackAbort = null;
      if (!this.stopped) this.callbacks.onStatus('Ready');
    }
  }
}
