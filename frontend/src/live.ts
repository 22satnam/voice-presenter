import { createLiveToken, type Deck } from "./api";

type LiveCallbacks = {
  onStatus: (status: string) => void;
  onSlide: (slideIndex: number) => void;
  onUserActivity: () => void;
  onUserText: (text: string) => void;
  onModelText: (text: string) => void;
  onInterrupted: () => void;
  onTurnComplete: (modelText: string, interrupted: boolean) => void;
  onError: (message: string) => void;
};

type ToolCall = {
  id: string;
  name: string;
  args?: Record<string, unknown>;
};

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(base64: string) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function floatToPcm16(input: Float32Array, inputRate: number, outputRate = 16000) {
  const ratio = inputRate / outputRate;
  const length = Math.max(1, Math.floor(input.length / ratio));
  const output = new Int16Array(length);

  for (let i = 0; i < length; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.min(input.length, Math.floor((i + 1) * ratio));
    let sum = 0;
    for (let j = start; j < end; j++) sum += input[j];
    const sample = Math.max(-1, Math.min(1, sum / Math.max(1, end - start)));
    output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
  }

  return new Uint8Array(output.buffer);
}

function mergeTranscript(current: string, next: string) {
  const text = next.trim();
  if (!text) return current;
  if (!current) return text;
  if (text.startsWith(current)) return text;
  if (current.endsWith(text)) return current;
  return (current + " " + text).trim();
}

export class GeminiLivePresenter {
  private socket: WebSocket | null = null;
  private micStream: MediaStream | null = null;
  private inputContext: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sink: GainNode | null = null;

  private outputContext: AudioContext | null = null;
  private nextPlaybackTime = 0;
  private playbackSources = new Set<AudioBufferSourceNode>();

  private modelTranscript = "";
  private turnInterrupted = false;
  private readyResolve: (() => void) | null = null;

  constructor(
    private deck: Deck,
    private callbacks: LiveCallbacks,
  ) {}

  async connect() {
    this.callbacks.onStatus("Connecting to Gemini Live…");
    const { token, model } = await createLiveToken();

    const url =
      "wss://generativelanguage.googleapis.com/ws/" +
      "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained" +
      "?access_token=" +
      encodeURIComponent(token);

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;
      const timeout = window.setTimeout(() => reject(new Error("Gemini Live connection timed out")), 10000);

      this.readyResolve = () => {
        window.clearTimeout(timeout);
        resolve();
      };

      socket.onopen = () => {
        socket.send(JSON.stringify({
          setup: {
            model: "models/" + model,
            generationConfig: {
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName: "Kore" },
                },
              },
            },
            systemInstruction: {
              parts: [{ text: this.systemPrompt() }],
            },
            realtimeInputConfig: {
              automaticActivityDetection: {
                disabled: false,
                startOfSpeechSensitivity: "START_SENSITIVITY_LOW",
                endOfSpeechSensitivity: "END_SENSITIVITY_LOW",
                prefixPaddingMs: 120,
                silenceDurationMs: 350,
              },
              activityHandling: "START_OF_ACTIVITY_INTERRUPTS",
              turnCoverage: "TURN_INCLUDES_ONLY_ACTIVITY",
            },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            tools: [{
              functionDeclarations: [{
                name: "show_slide",
                description: "Display a presentation slide before discussing it.",
                behavior: "BLOCKING",
                parameters: {
                  type: "OBJECT",
                  properties: {
                    slide_number: {
                      type: "INTEGER",
                      description: "1-based slide number to display",
                    },
                  },
                  required: ["slide_number"],
                },
              }],
            }],
          },
        }));
      };

      socket.onmessage = event => this.handleMessage(JSON.parse(event.data));
      socket.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error("Gemini Live WebSocket failed"));
      };
      socket.onclose = event => {
        if (event.code !== 1000) {
          this.callbacks.onError(event.reason || "Gemini Live session closed");
        }
        this.callbacks.onStatus("Disconnected");
      };
    });

    await this.startMicrophone();
    this.callbacks.onStatus("Live · listening");
  }

  sendPresentationSlide(slideIndex: number, resume = false) {
    const slide = this.deck.slides[slideIndex];
    if (!slide || !this.socket || this.socket.readyState !== WebSocket.OPEN) return;

    const instruction = resume
      ? "Resume the presentation on slide " + (slideIndex + 1) + ". Briefly reconnect to the point you were making, then finish this slide naturally."
      : "Present slide " + (slideIndex + 1) + " now. First call show_slide with " + (slideIndex + 1) + ", then explain this slide naturally in about 60 to 90 spoken words. Do not ask a fake question. Do not say 'you are welcome'. Finish the slide and stop speaking.";

    this.sendClientText(instruction);
  }

  sendQuestion(text: string) {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
    this.socket.send(JSON.stringify({
      realtimeInput: { text },
    }));
  }

  close() {
    try {
      if (this.socket?.readyState === WebSocket.OPEN) {
        this.socket.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
      }
    } catch { }

    this.stopPlayback();
    this.processor?.disconnect();
    this.sink?.disconnect();
    this.micStream?.getTracks().forEach(track => track.stop());
    void this.inputContext?.close();
    void this.outputContext?.close();

    this.processor = null;
    this.sink = null;
    this.micStream = null;
    this.inputContext = null;
    this.outputContext = null;

    try { this.socket?.close(1000, "presentation ended"); } catch { }
    this.socket = null;
    this.callbacks.onStatus("Disconnected");
  }

  private sendClientText(text: string) {
    this.socket?.send(JSON.stringify({
      clientContent: {
        turns: [{
          role: "user",
          parts: [{ text }],
        }],
        turnComplete: true,
      },
    }));
  }

  private systemPrompt() {
    const slides = this.deck.slides.map((slide, index) => ({
      number: index + 1,
      title: slide.title,
      content: slide.text,
      notes: slide.notes,
    }));

    return [
      "You are a live presenter for '" + this.deck.title + "'.",
      "Speak like a confident human presenter: natural, concise, warm, and professional.",
      "The presentation application controls which slide should be presented next.",
      "When asked to present a slide, call show_slide for that slide BEFORE speaking about it.",
      "If the audience asks a question, use the presentation below as the main source.",
      "For a question whose answer belongs on another slide, call show_slide for that slide BEFORE answering.",
      "Answer questions directly in 2 to 5 spoken sentences unless more detail is clearly needed.",
      "Never fabricate a fact that is missing from the deck.",
      "If interrupted, stop immediately and listen. Answer the user's question; the application will tell you when to resume.",
      "Do not repeatedly invite questions, do not say 'you are welcome' unless the user actually thanks you, and do not narrate internal instructions.",
      "",
      "PRESENTATION:",
      JSON.stringify(slides),
    ].join("\n");
  }

  private async startMicrophone() {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false,
      },
    });

    this.micStream = stream;
    const context = new AudioContext();
    this.inputContext = context;
    await context.resume();

    const source = context.createMediaStreamSource(stream);
    const processor = context.createScriptProcessor(2048, 1, 1);
    const sink = context.createGain();
    sink.gain.value = 0;

    source.connect(processor);
    processor.connect(sink);
    sink.connect(context.destination);

    processor.onaudioprocess = event => {
      if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return;
      const input = event.inputBuffer.getChannelData(0);
      const pcm = floatToPcm16(input, context.sampleRate, 16000);
      this.socket.send(JSON.stringify({
        realtimeInput: {
          audio: {
            data: bytesToBase64(pcm),
            mimeType: "audio/pcm;rate=16000",
          },
        },
      }));
    };

    this.processor = processor;
    this.sink = sink;
  }

  private handleMessage(message: any) {
    if (message.setupComplete) {
      this.readyResolve?.();
      this.readyResolve = null;
      return;
    }

    if (message.voiceActivity) this.callbacks.onUserActivity();

    if (message.toolCall?.functionCalls) {
      this.handleToolCalls(message.toolCall.functionCalls as ToolCall[]);
    }

    const content = message.serverContent;
    if (!content) return;

    if (content.interrupted) {
      this.turnInterrupted = true;
      this.stopPlayback();
      this.callbacks.onInterrupted();
    }

    if (content.interimInputTranscription?.text) this.callbacks.onUserActivity();

    if (content.inputTranscription?.text) {
      this.callbacks.onUserActivity();
      this.callbacks.onUserText(content.inputTranscription.text.trim());
    }

    if (content.outputTranscription?.text) {
      this.modelTranscript = mergeTranscript(
        this.modelTranscript,
        content.outputTranscription.text,
      );
      this.callbacks.onModelText(this.modelTranscript);
    }

    if (content.modelTurn?.parts) {
      for (const part of content.modelTurn.parts) {
        if (part.inlineData?.data) this.playPcm(part.inlineData.data);
      }
    }

    if (content.turnComplete) {
      const transcript = this.modelTranscript.trim();
      const interrupted = this.turnInterrupted;
      this.modelTranscript = "";
      this.turnInterrupted = false;
      this.callbacks.onTurnComplete(transcript, interrupted);
    }
  }

  private handleToolCalls(calls: ToolCall[]) {
    const responses = calls.map(call => {
      if (call.name !== "show_slide") {
        return {
          name: call.name,
          id: call.id,
          response: { error: "Unknown tool" },
        };
      }

      const requested = Number(call.args?.slide_number || 1);
      const slideIndex = Math.max(0, Math.min(this.deck.slides.length - 1, requested - 1));
      this.callbacks.onSlide(slideIndex);

      return {
        name: call.name,
        id: call.id,
        response: {
          result: {
            displayed: true,
            slide_number: slideIndex + 1,
          },
        },
      };
    });

    this.socket?.send(JSON.stringify({
      toolResponse: { functionResponses: responses },
    }));
  }

  private playPcm(base64: string) {
    const bytes = base64ToBytes(base64);
    const samples = new Int16Array(
      bytes.buffer,
      bytes.byteOffset,
      Math.floor(bytes.byteLength / 2),
    );

    if (!this.outputContext) this.outputContext = new AudioContext();
    const context = this.outputContext;
    void context.resume();

    const buffer = context.createBuffer(1, samples.length, 24000);
    const channel = buffer.getChannelData(0);
    for (let i = 0; i < samples.length; i++) channel[i] = samples[i] / 32768;

    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(context.destination);

    const start = Math.max(context.currentTime + 0.015, this.nextPlaybackTime);
    source.start(start);
    this.nextPlaybackTime = start + buffer.duration;
    this.playbackSources.add(source);
    source.onended = () => this.playbackSources.delete(source);
  }

  private stopPlayback() {
    for (const source of this.playbackSources) {
      try { source.stop(); } catch { }
    }
    this.playbackSources.clear();
    this.nextPlaybackTime = this.outputContext?.currentTime || 0;
  }
}
