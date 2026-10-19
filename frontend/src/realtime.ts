import { MicVAD } from '@ricky0123/vad-web';
import { deepgramToken, transcribeAudio } from './api';

export type VoiceStatus = 'Mic off' | 'Connecting' | 'Ready' | 'User speaking' | 'Transcribing';

export type VoiceCallbacks = {
  onStatus: (status: VoiceStatus) => void;
  onSpeechStart: () => void;
  onSpeechConfirmed: () => void;
  onSpeechMisfire: () => void;
  onEagerEnd: (transcript: string) => void;
  onTurnResumed: () => void;
  onFinal: (transcript: string) => void;
};

type TurnInfo = {
  type?: string;
  event?: string;
  transcript?: string;
};

export class RealtimeVoice {
  private stream: MediaStream | null = null;
  private vad: MicVAD | null = null;
  private recorder: MediaRecorder | null = null;
  private socket: WebSocket | null = null;
  private keepAlive = 0;
  private ring: Blob[] = [];
  private utterance: Blob[] = [];
  private sending = false;
  private flux = false;
  private stopped = true;
  private fallbackAbort: AbortController | null = null;

  constructor(private callbacks: VoiceCallbacks) {}

  get usingFlux() {
    return this.flux;
  }

  async start() {
    if (!this.stopped) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
      throw new Error('Microphone recording is unavailable in this browser.');
    }

    this.stopped = false;
    this.callbacks.onStatus('Connecting');

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      },
    });

    await Promise.all([
      this.startVad(this.stream),
      this.connectFlux().catch(() => {
        this.flux = false;
      }),
    ]);

    this.startRecorder(this.stream);
    this.vad?.start();
    this.callbacks.onStatus('Ready');
  }

  stop() {
    this.stopped = true;
    this.fallbackAbort?.abort();
    this.fallbackAbort = null;
    window.clearInterval(this.keepAlive);

    try { this.recorder?.stop(); } catch { /* already stopped */ }
    this.recorder = null;

    try { this.socket?.close(1000, 'presentation ended'); } catch { /* already closed */ }
    this.socket = null;

    this.vad?.pause();
    this.vad = null;

    this.stream?.getTracks().forEach(track => track.stop());
    this.stream = null;

    this.ring = [];
    this.utterance = [];
    this.sending = false;
    this.flux = false;
    this.callbacks.onStatus('Mic off');
  }

  private async connectFlux() {
    const token = await deepgramToken();
    if (this.stopped) return;

    const url = new URL('wss://api.deepgram.com/v2/listen');
    url.searchParams.set('model', 'flux-general-en');
    url.searchParams.set('eager_eot_threshold', '0.6');
    url.searchParams.set('eot_threshold', '0.8');
    url.searchParams.set('eot_timeout_ms', '3500');

    const socket = new WebSocket(url.toString(), ['bearer', token]);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const timeout = window.setTimeout(() => reject(new Error('Deepgram connection timed out')), 5000);
      socket.onopen = () => {
        window.clearTimeout(timeout);
        this.flux = true;
        resolve();
      };
      socket.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error('Deepgram Flux connection failed'));
      };
    });

    socket.onmessage = event => {
      if (typeof event.data !== 'string') return;
      let message: TurnInfo;
      try { message = JSON.parse(event.data) as TurnInfo; } catch { return; }
      if (message.type !== 'TurnInfo') return;

      const transcript = (message.transcript || '').trim();
      if (message.event === 'StartOfTurn') {
        this.callbacks.onSpeechStart();
      } else if (message.event === 'EagerEndOfTurn' && transcript) {
        this.callbacks.onEagerEnd(transcript);
      } else if (message.event === 'TurnResumed') {
        this.callbacks.onTurnResumed();
      } else if (message.event === 'EndOfTurn' && transcript) {
        this.sending = false;
        this.utterance = [];
        this.callbacks.onStatus('Ready');
        this.callbacks.onFinal(transcript);
      }
    };

    socket.onclose = () => {
      if (!this.stopped) {
        this.flux = false;
        this.callbacks.onStatus('Ready');
      }
    };

    this.keepAlive = window.setInterval(() => {
      if (socket.readyState === WebSocket.OPEN && !this.sending) {
        socket.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    }, 8000);
  }

  private startRecorder(stream: MediaStream) {
    const mime = ['audio/webm;codecs=opus', 'audio/webm']
      .find(type => MediaRecorder.isTypeSupported(type));
    this.recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);

    this.recorder.ondataavailable = event => {
      if (!event.data.size) return;

      this.ring.push(event.data);
      if (this.ring.length > 5) this.ring.shift();

      if (!this.sending) return;
      this.utterance.push(event.data);

      if (this.flux && this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(event.data);
      }
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
      redemptionMs: 550,
      preSpeechPadMs: 160,
      getStream: async () => stream,
      pauseStream: async () => {},
      resumeStream: async () => stream,
      onSpeechStart: () => {
        if (this.stopped) return;
        this.sending = true;
        this.utterance = [...this.ring];

        if (this.flux && this.socket?.readyState === WebSocket.OPEN) {
          for (const chunk of this.ring) this.socket.send(chunk);
        }

        this.callbacks.onStatus('User speaking');
        this.callbacks.onSpeechStart();
      },
      onSpeechRealStart: () => {
        if (!this.stopped) this.callbacks.onSpeechConfirmed();
      },
      onVADMisfire: () => {
        this.sending = false;
        this.utterance = [];
        if (!this.stopped) {
          this.callbacks.onStatus('Ready');
          this.callbacks.onSpeechMisfire();
        }
      },
      onSpeechEnd: () => {
        if (this.stopped) return;

        // With Flux, keep a short tail of silence so its turn model can finish.
        if (this.flux) {
          window.setTimeout(() => {
            if (!this.stopped) this.sending = false;
          }, 700);
          return;
        }

        const chunks = [...this.utterance];
        this.sending = false;
        this.utterance = [];
        if (!chunks.length) return;
        void this.batchFallback(chunks);
      },
    });
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
