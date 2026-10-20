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

export class VoicePresenterSession {
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
  private readyReject: ((error: Error) => void) | null = null;
  private closing = false;

  constructor(
    private deck: Deck,
    private callbacks: LiveCallbacks,
  ) {}

  unlockAudio() {
    if (!this.outputContext) this.outputContext = new AudioContext();
    void this.outputContext.resume();
  }

  async connect() {
    this.closing = false;

    // Request microphone access first, directly from the Present click path.
    // If this fails we never create a remote voice session.
    this.callbacks.onStatus("Requesting microphone…");
    await this.startMicrophone();

    this.callbacks.onStatus("Connecting…");
    const { token, model } = await createLiveToken();

    const url =
      "wss://generativelanguage.googleapis.com/ws/" +
      "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContentConstrained" +
      "?access_token=" +
      encodeURIComponent(token);

    await new Promise<void>((resolve, reject) => {
      const socket = new WebSocket(url);
      this.socket = socket;
      const timeout = window.setTimeout(() => {
        reject(new Error("Voice session connection timed out"));
      }, 10000);

      this.readyResolve = () => {
        window.clearTimeout(timeout);
        this.readyResolve = null;
        this.readyReject = null;
        resolve();
      };
      this.readyReject = error => {
        window.clearTimeout(timeout);
        this.readyResolve = null;
        this.readyReject = null;
        reject(error);
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

      socket.onmessage = event => {
        try {
          this.handleMessage(JSON.parse(event.data));
        } catch {
          this.callbacks.onError("Received an invalid realtime response");
        }
      };

      socket.onerror = () => {
        this.readyReject?.(new Error("Could not open the voice connection"));
      };

      socket.onclose = event => {
        window.clearTimeout(timeout);
        const reason = event.reason?.trim();
        this.readyReject?.(
          new Error(reason || "Voice session closed during startup"),
        );

        if (this.closing) return;

        const message = reason
          ? "Voice connection ended: " + reason
          : "Voice connection ended unexpectedly (code " + event.code + ").";
        this.callbacks.onError(message);
        this.callbacks.onStatus("Connection lost");
      };
    });

    this.callbacks.onStatus("Listening");
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
    this.sendClientText("Audience question: " + text);
  }

  close() {
    this.closing = true;

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
    this.nextPlaybackTime = 0;

    const socket = this.socket;
    this.socket = null;
    try { socket?.close(1000, "presentation ended"); } catch { }
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
    if (!navigator.mediaDevices?.getUserMedia) {
      throw new Error("Microphone access is not supported in this browser");
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: false,
        },
      });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : "";
      if (name === "NotAllowedError" || name === "PermissionDeniedError") {
        throw new Error("Microphone permission is required. Allow microphone access and try again.");
      }
      if (name === "NotFoundError" || name === "DevicesNotFoundError") {
        throw new Error("No microphone was found on this device.");
      }
      throw new Error("Could not start the microphone. Check browser microphone access and try again.");
    }

    this.micStream = stream;
    const context = new AudioContext();
    this.inputContext = context;

    try {
      await context.resume();
    } catch {
      stream.getTracks().forEach(track => track.stop());
      throw new Error("The browser could not start microphone audio.");
    }

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
        if (part.inlineData?.data) {
          const mime = String(part.inlineData.mimeType || "");
          const rate = Number(mime.match(/rate=(\d+)/i)?.[1] || 24000);
          this.playPcm(part.inlineData.data, rate);
        }
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

  private playPcm(base64: string, sampleRate = 24000) {
    const bytes = base64ToBytes(base64);
    const samples = new Int16Array(
      bytes.buffer,
      bytes.byteOffset,
      Math.floor(bytes.byteLength / 2),
    );

    if (!this.outputContext) this.outputContext = new AudioContext();
    const context = this.outputContext;
    void context.resume();

    const buffer = context.createBuffer(1, samples.length, sampleRate);
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
