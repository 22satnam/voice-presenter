import { useEffect, useRef, useState } from 'react';
import {
  api,
  speechAudio,
  streamAnswer,
  type Deck,
  type DeckItem,
  type PreparedNarration,
} from './api';
import {
  CACHE_VERSION,
  readPreparedDeck,
  savePreparedDeck,
  sentenceBoundary,
  splitSentences,
  type CachedDeck,
  type CachedSlide,
} from './cache';
import { RealtimeVoice, type VoiceStatus } from './realtime';
import { Speaker } from './voice';

type Message = {
  role: 'Presenter' | 'You';
  text: string;
  slide?: number;
  narration?: boolean;
};

type PreparedAnswer = {
  slideIndex: number;
  text: string;
  sentences: { text: string; audio: Promise<ArrayBuffer | null> }[];
};

type Waiter = {
  promise: Promise<void>;
  resolve: () => void;
};

type DraftAnswer = {
  transcript: string;
  controller: AbortController;
  promise: Promise<PreparedAnswer>;
};

const IGNORED_SPEECH = new Set([
  'thank you', 'thanks', 'thank you very much', 'thanks a lot',
  'okay', 'ok', 'alright', 'yes', 'no', 'great', 'cool', 'got it',
  'hmm', 'um', 'uh',
]);

const FILLERS = {
  goodQuestion: 'Good question — let me pull that up.',
  letMeShowYou: 'Sure — let me show you the relevant slide.',
  anyQuestions: 'I will pause here for a moment. Any questions before I move on?',
  finalQuestions: 'That brings us to the end of the presentation. Any questions?',
};

function cleanSpeech(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function looksLikeEcho(question: string, spokenText: string) {
  const questionText = cleanSpeech(question);
  const sourceText = cleanSpeech(spokenText);
  if (!questionText || !sourceText) return false;
  if (questionText.length >= 25 && sourceText.includes(questionText)) return true;

  const words = [...new Set(questionText.split(' ').filter(word => word.length > 2))];
  if (words.length < 5) return false;
  const sourceWords = new Set(sourceText.split(' '));
  const overlap = words.filter(word => sourceWords.has(word)).length;
  return overlap / words.length >= 0.9;
}

function completeSentences(buffer: string) {
  const sentences: string[] = [];
  let rest = buffer;
  while (true) {
    const match = rest.match(/^([\s\S]*?[.!?])(?:\s+|$)/);
    if (!match) break;
    const sentence = match[1].trim();
    if (sentence) sentences.push(sentence);
    rest = rest.slice(match[0].length);
  }
  return { sentences, rest };
}

async function runPool<T>(
  jobs: (() => Promise<T>)[],
  concurrency: number,
  onDone: () => void,
): Promise<T[]> {
  const results = new Array<T>(jobs.length);
  let cursor = 0;

  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= jobs.length) return;
      results[index] = await jobs[index]();
      onDone();
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, worker));
  return results;
}

export default function App() {
  const [decks, setDecks] = useState<DeckItem[]>([]);
  const [deck, setDeck] = useState<Deck | null>(null);
  const [slide, setSlide] = useState(0);
  const [running, setRunning] = useState(false);
  const [busy, setBusy] = useState(false);
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [error, setError] = useState('');
  const [voice, setVoice] = useState('');
  const [micStatus, setMicStatus] = useState<VoiceStatus>('Mic off');
  const [loadingText, setLoadingText] = useState('');
  const [deckReady, setDeckReady] = useState(false);
  const [prepProgress, setPrepProgress] = useState({ done: 0, total: 0 });

  const active = useRef<AbortController | null>(null);
  const preparation = useRef<AbortController | null>(null);
  const current = useRef(0);
  const messagesRef = useRef<Message[]>([]);
  const preparedDeck = useRef<CachedDeck | null>(null);
  const decoded = useRef(new Map<string, AudioBuffer>());
  const speaker = useRef(new Speaker());
  const realtime = useRef<RealtimeVoice | null>(null);
  const currentSentence = useRef<{ slideIndex: number; text: string } | null>(null);
  const interrupt = useRef<Waiter | null>(null);
  const checkpoint = useRef<Waiter | null>(null);
  const speculative = useRef<DraftAnswer | null>(null);
  const presentationActive = useRef(false);
  const handlingQuestion = useRef(false);
  const lastTranscript = useRef({ text: '', at: 0 });
  const fillerCounter = useRef(0);

  const onSpeechStartRef = useRef(() => {});
  const onSpeechConfirmedRef = useRef(() => {});
  const onSpeechMisfireRef = useRef(() => {});
  const onEagerRef = useRef((_text: string) => {});
  const onTurnResumedRef = useRef(() => {});
  const onFinalRef = useRef((_text: string) => {});

  useEffect(() => {
    api<DeckItem[]>('/api/decks').then(setDecks).catch(err => setError(err.message));
    return () => {
      active.current?.abort();
      preparation.current?.abort();
      speculative.current?.controller.abort();
      speaker.current.stop();
      realtime.current?.stop();
    };
  }, []);

  function getRealtime() {
    if (!realtime.current) {
      realtime.current = new RealtimeVoice({
        onStatus: setMicStatus,
        onSpeechStart: () => onSpeechStartRef.current(),
        onSpeechConfirmed: () => onSpeechConfirmedRef.current(),
        onSpeechMisfire: () => onSpeechMisfireRef.current(),
        onEagerEnd: text => onEagerRef.current(text),
        onTurnResumed: () => onTurnResumedRef.current(),
        onFinal: text => onFinalRef.current(text),
      });
    }
    return realtime.current;
  }

  function addMessage(message: Message) {
    messagesRef.current = [...messagesRef.current, message];
    setMessages(messagesRef.current);
  }

  function recentHistory() {
    return messagesRef.current
      .filter(message => !message.narration)
      .slice(-6)
      .map(message => ({
        role: message.role === 'You' ? 'user' : 'assistant',
        text: message.text,
      }));
  }

  function ensureInterruptWaiter() {
    if (interrupt.current) return interrupt.current;
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    interrupt.current = { promise, resolve };
    return interrupt.current;
  }

  function resolveInterrupt() {
    interrupt.current?.resolve();
    interrupt.current = null;
    speaker.current.restore();
  }

  function ensureCheckpointWaiter() {
    if (checkpoint.current) return checkpoint.current;
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    checkpoint.current = { promise, resolve };
    return checkpoint.current;
  }

  function resolveCheckpoint() {
    checkpoint.current?.resolve();
    checkpoint.current = null;
  }

  function stop() {
    active.current?.abort();
    active.current = null;
    speculative.current?.controller.abort();
    speculative.current = null;
    speaker.current.stop();
    realtime.current?.stop();
    presentationActive.current = false;
    handlingQuestion.current = false;
    currentSentence.current = null;
    resolveInterrupt();
    resolveCheckpoint();
    setRunning(false);
    setBusy(false);
    setLoadingText('');
  }

  async function audioWithRetry(text: string, signal: AbortSignal) {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return await speechAudio(text, signal);
      } catch (error) {
        if (signal.aborted) throw error;
        lastError = error;
        await new Promise(resolve => window.setTimeout(resolve, 1200 * (attempt + 1)));
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Voice generation failed');
  }

  async function prepareSelectedDeck(picked: Deck, signal: AbortSignal) {
    setDeckReady(false);
    setPrepProgress({ done: 0, total: 0 });
    setLoadingText('Checking prepared presentation…');

    const cached = await readPreparedDeck(picked.id).catch(() => null);
    if (cached && !signal.aborted) {
      preparedDeck.current = cached;
      setDeckReady(true);
      setLoadingText('');
      return;
    }

    setLoadingText('Writing narration for the full presentation…');
    const narration = await api<PreparedNarration>(
      '/api/prepare-deck',
      { deck_id: picked.id },
      signal,
    );
    if (signal.aborted) return;

    const fillerEntries = Object.entries(FILLERS) as [keyof CachedDeck['fillers'], string][];
    const total = narration.slides.length + fillerEntries.length;
    let done = 0;
    setPrepProgress({ done, total });
    setLoadingText('Generating natural voice slide by slide…');

    const pacedAudio = async (text: string) => {
      const audio = await audioWithRetry(text, signal);
      done += 1;
      setPrepProgress({ done, total });
      // Keep preparation below bursty speech-model limits.
      await new Promise(resolve => window.setTimeout(resolve, 450));
      return audio;
    };

    // One Gemini TTS call per slide, sequentially. This is deliberately not parallel.
    const slideAudio: ArrayBuffer[] = [];
    for (const item of narration.slides) {
      if (signal.aborted) return;
      slideAudio.push(await pacedAudio(item.text));
    }

    const fillers = {} as CachedDeck['fillers'];
    for (const [key, text] of fillerEntries) {
      if (signal.aborted) return;
      fillers[key] = await pacedAudio(text);
    }

    if (signal.aborted) return;

    const slides: CachedSlide[] = narration.slides.map((item, slideIndex) => ({
      text: item.text,
      sentences: splitSentences(item.text),
      audio: slideAudio[slideIndex],
    }));

    const prepared: CachedDeck = {
      cacheVersion: CACHE_VERSION,
      deckId: picked.id,
      slides,
      fillers,
    };

    preparedDeck.current = prepared;
    await savePreparedDeck(prepared).catch(() => {});
    setDeckReady(true);
    setLoadingText('');
  }

  async function openDeck(id: string) {
    stop();
    preparation.current?.abort();
    const controller = new AbortController();
    preparation.current = controller;
    setError('');
    setBusy(true);
    setDeckReady(false);
    preparedDeck.current = null;
    decoded.current.clear();

    try {
      const picked = await api<Deck>('/api/decks/' + id, undefined, controller.signal);
      if (controller.signal.aborted) return;
      setDeck(picked);
      setSlide(0);
      current.current = 0;
      messagesRef.current = [];
      setMessages([]);
      setVoice('');
      setBusy(false);
      await prepareSelectedDeck(picked, controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Could not prepare presentation');
        setLoadingText('');
        setBusy(false);
      }
    }
  }

  function selectSlide(index: number) {
    if (!deck || running) return;
    const next = Math.max(0, Math.min(index, deck.slides.length - 1));
    current.current = next;
    setSlide(next);
  }

  async function decodedSlide(slideIndex: number) {
    const key = 'slide:' + slideIndex;
    const cached = decoded.current.get(key);
    if (cached) return cached;

    const prepared = preparedDeck.current?.slides[slideIndex];
    if (!prepared) throw new Error('Prepared narration is missing');
    const buffer = await speaker.current.decode(prepared.audio);
    decoded.current.set(key, buffer);
    return buffer;
  }

  async function fillerBuffer(name: keyof CachedDeck['fillers']) {
    const key = 'filler:' + name;
    const cached = decoded.current.get(key);
    if (cached) return cached;
    const audio = preparedDeck.current?.fillers[name];
    if (!audio) throw new Error('Prepared filler audio is missing');
    const buffer = await speaker.current.decode(audio);
    decoded.current.set(key, buffer);
    return buffer;
  }

  function transcriptAllowed(text: string, spokenText = '', commit = true) {
    const cleaned = cleanSpeech(text);
    if (!cleaned || IGNORED_SPEECH.has(cleaned)) return '';
    if (spokenText && looksLikeEcho(text, spokenText)) return '';

    if (commit) {
      const now = Date.now();
      if (cleaned === lastTranscript.current.text && now - lastTranscript.current.at < 10000) {
        return '';
      }
      lastTranscript.current = { text: cleaned, at: now };
    }

    return text.trim();
  }

  async function buildStreamAnswer(
    text: string,
    controller: AbortController,
    onSlide?: (index: number) => void,
  ): Promise<PreparedAnswer> {
    if (!deck) throw new Error('No presentation selected');

    let slideIndex = current.current;
    let fullText = '';
    let pending = '';
    const sentences: PreparedAnswer['sentences'] = [];
    let ttsChain: Promise<void> = Promise.resolve();

    const queueSentence = (sentence: string) => {
      const clean = sentence.trim();
      if (!clean) return;

      const audio = ttsChain
        .then(() => audioWithRetry(clean, controller.signal))
        .catch(() => null);

      ttsChain = audio.then(() => undefined, () => undefined);
      sentences.push({ text: clean, audio });
    };

    await streamAnswer(
      {
        deck_id: deck.id,
        current_slide: current.current,
        question: text,
        history: recentHistory(),
      },
      controller.signal,
      {
        onSlide: index => {
          slideIndex = index;
          onSlide?.(index);
        },
        onText: chunk => {
          fullText += chunk;
          pending += chunk;
          const parsed = completeSentences(pending);
          pending = parsed.rest;
          parsed.sentences.forEach(queueSentence);
        },
      },
    );

    if (pending.trim()) queueSentence(pending.trim());
    if (!fullText.trim()) throw new Error('Gemini returned an empty answer');

    return { slideIndex, text: fullText.trim(), sentences };
  }

  function startSpeculativeAnswer(transcript: string) {
    if (!presentationActive.current || handlingQuestion.current) return;
    const spoken = currentSentence.current?.text || '';
    const clean = transcriptAllowed(transcript, spoken, false);
    if (!clean) return;

    speculative.current?.controller.abort();
    const controller = new AbortController();
    active.current?.signal.addEventListener('abort', () => controller.abort(), { once: true });
    speculative.current = {
      transcript: cleanSpeech(clean),
      controller,
      promise: buildStreamAnswer(clean, controller),
    };
  }

  function cancelSpeculativeAnswer() {
    speculative.current?.controller.abort();
    speculative.current = null;
  }

  async function playPreparedAnswer(answer: PreparedAnswer, signal: AbortSignal) {
    setSlide(answer.slideIndex);
    current.current = answer.slideIndex;
    addMessage({ role: 'Presenter', text: answer.text, slide: answer.slideIndex + 1 });

    for (const sentence of answer.sentences) {
      if (signal.aborted) return;
      let audio = await sentence.audio;
      if (!audio) audio = await audioWithRetry(sentence.text, signal);
      const buffer = await speaker.current.decode(audio);
      await speaker.current.play(buffer, signal, setVoice);
    }
  }

  async function handleVoiceQuestion(rawTranscript: string) {
    if (!deck || handlingQuestion.current) return;

    const origin = currentSentence.current?.slideIndex ?? current.current;
    const spoken = currentSentence.current?.text || '';
    const transcript = transcriptAllowed(rawTranscript, spoken, true);

    if (!transcript) {
      cancelSpeculativeAnswer();
      speaker.current.restore();
      resolveInterrupt();
      resolveCheckpoint();
      return;
    }

    handlingQuestion.current = true;
    setLoadingText('Understanding your question…');
    addMessage({ role: 'You', text: transcript });

    const parentSignal = active.current?.signal;
    const normalized = cleanSpeech(transcript);
    let answerPromise: Promise<PreparedAnswer>;

    if (speculative.current?.transcript === normalized && !speculative.current.controller.signal.aborted) {
      answerPromise = speculative.current.promise;
    } else {
      cancelSpeculativeAnswer();
      const controller = new AbortController();
      parentSignal?.addEventListener('abort', () => controller.abort(), { once: true });
      speculative.current = {
        transcript: normalized,
        controller,
        promise: buildStreamAnswer(transcript, controller),
      };
      answerPromise = speculative.current.promise;
    }

    try {
      const fillerName = fillerCounter.current++ % 2 === 0 ? 'goodQuestion' : 'letMeShowYou';
      const filler = await fillerBuffer(fillerName);
      const fillerController = active.current;
      if (fillerController && !fillerController.signal.aborted) {
        await speaker.current.play(filler, fillerController.signal, setVoice);
      }

      setLoadingText('Finding the relevant slide…');
      const answer = await answerPromise;
      if (active.current?.signal.aborted) return;

      setSlide(answer.slideIndex);
      current.current = answer.slideIndex;
      setLoadingText('');
      await playPreparedAnswer(answer, active.current!.signal);

      if (presentationActive.current && !active.current?.signal.aborted) {
        current.current = origin;
        setSlide(origin);
      }
    } catch (err) {
      if (!active.current?.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Could not answer that question');
      }
    } finally {
      cancelSpeculativeAnswer();
      handlingQuestion.current = false;
      setLoadingText('');
      resolveInterrupt();
      resolveCheckpoint();
    }
  }

  onSpeechStartRef.current = () => {
    if (!presentationActive.current || handlingQuestion.current) return;
    if (currentSentence.current) speaker.current.duck();
  };

  onSpeechConfirmedRef.current = () => {
    if (!presentationActive.current || handlingQuestion.current) return;
    if (!currentSentence.current) return;
    ensureInterruptWaiter();
    speaker.current.interrupt();
    setLoadingText('Listening…');
  };

  onSpeechMisfireRef.current = () => {
    if (!handlingQuestion.current) speaker.current.restore();
  };

  onEagerRef.current = transcript => {
    if (!interrupt.current || handlingQuestion.current) return;
    startSpeculativeAnswer(transcript);
  };

  onTurnResumedRef.current = () => {
    cancelSpeculativeAnswer();
    setLoadingText('Listening…');
  };

  onFinalRef.current = transcript => {
    if (handlingQuestion.current) return;
    if (!interrupt.current && currentSentence.current) {
      ensureInterruptWaiter();
      speaker.current.interrupt();
    }
    void handleVoiceQuestion(transcript);
  };

  async function askCheckpoint(controller: AbortController, isLast: boolean) {
    if (controller.signal.aborted || handlingQuestion.current) return;

    const name = isLast ? 'finalQuestions' : 'anyQuestions';
    const prompt = await fillerBuffer(name);
    currentSentence.current = null;
    await speaker.current.play(prompt, controller.signal, setVoice);

    if (controller.signal.aborted) return;

    const waiter = ensureCheckpointWaiter();
    await Promise.race([
      waiter.promise,
      new Promise<void>(resolve => window.setTimeout(resolve, isLast ? 6500 : 4000)),
    ]);
    resolveCheckpoint();
  }

  async function present() {
    if (!deck || !preparedDeck.current || !deckReady || running) return;

    speaker.current.unlock();
    setError('');
    setRunning(true);
    setLoadingText('Starting presenter…');

    const controller = new AbortController();
    active.current = controller;
    presentationActive.current = true;

    try {
      const voice = getRealtime();
      await voice.start().catch(() => {
        setError('Realtime microphone could not start. The presentation will continue without interruptions.');
      });

      setLoadingText('');
      const start = current.current;

      for (let slideIndex = start; slideIndex < preparedDeck.current.slides.length; slideIndex++) {
        if (controller.signal.aborted) break;

        current.current = slideIndex;
        setSlide(slideIndex);

        const preparedSlide = preparedDeck.current.slides[slideIndex];
        addMessage({
          role: 'Presenter',
          text: preparedSlide.text,
          slide: slideIndex + 1,
          narration: true,
        });

        const buffer = await decodedSlide(slideIndex);
        let offset = 0;

        while (!controller.signal.aborted && offset < buffer.duration - 0.03) {
          currentSentence.current = { slideIndex, text: preparedSlide.text };
          const result = await speaker.current.play(buffer, controller.signal, setVoice, offset);

          if (result.status === 'done') {
            currentSentence.current = null;
            break;
          }

          // Approximate the previous sentence boundary from narration text and audio duration.
          // This avoids hundreds of TTS calls while still restarting at a natural point.
          offset = sentenceBoundary(preparedSlide.sentences, buffer.duration, result.offset);
          const waiter = interrupt.current;
          if (waiter) await waiter.promise;
          currentSentence.current = null;
        }

        if (controller.signal.aborted) break;

        const isLast = slideIndex === preparedDeck.current.slides.length - 1;
        const checkpointDue = ((slideIndex - start + 1) % 2 === 0) || isLast;
        if (checkpointDue) await askCheckpoint(controller, isLast);

        if (!isLast && !controller.signal.aborted) {
          current.current = slideIndex + 1;
          setSlide(slideIndex + 1);
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Could not continue the presentation');
      }
    } finally {
      if (active.current === controller) active.current = null;
      presentationActive.current = false;
      currentSentence.current = null;
      cancelSpeculativeAnswer();
      realtime.current?.stop();
      speaker.current.stop();
      setRunning(false);
      setBusy(false);
      setLoadingText('');
    }
  }

  async function ask(rawQuestion: string) {
    const text = rawQuestion.trim();
    if (!deck || !text || running) return;

    speaker.current.unlock();
    setQuestion('');
    setError('');
    setRunning(true);
    setLoadingText('Finding the relevant slide…');

    const controller = new AbortController();
    active.current = controller;

    try {
      addMessage({ role: 'You', text });
      const answer = await buildStreamAnswer(text, controller, index => {
        current.current = index;
        setSlide(index);
      });
      setLoadingText('');
      await playPreparedAnswer(answer, controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Unable to answer');
      }
    } finally {
      if (active.current === controller) active.current = null;
      setRunning(false);
      setLoadingText('');
    }
  }

  const prepPercent = prepProgress.total
    ? Math.round((prepProgress.done / prepProgress.total) * 100)
    : 0;

  if (!deck) return (
    <main className="home">
      <h1>Voice Presenter</h1>
      <p>Choose a presentation. Narration and voice are prepared once, then reused for seamless playback.</p>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="decks">
        {decks.map(item => (
          <button key={item.id} className="deck" disabled={busy} onClick={() => void openDeck(item.id)}>
            <img src={item.cover} alt={item.title + ' cover'} />
            <strong>{item.title}</strong>
            <span>{item.slide_count} slides</span>
            <p>{item.description}</p>
          </button>
        ))}
      </div>
    </main>
  );

  return (
    <main className="presenter">
      <header className="toolbar">
        <button onClick={() => { stop(); preparation.current?.abort(); setDeck(null); }}>← Back</button>
        <div className="heading">
          <strong>{deck.title}</strong>
          <small>
            Slide {slide + 1} of {deck.slides.length}
            {voice ? ' · ' + voice : ''}
            {running ? ' · ' + micStatus : ''}
          </small>
        </div>
        <div className="actions">
          {!running
            ? <button className="primary" disabled={!deckReady} onClick={() => void present()}>
                ▶ {deckReady ? 'Present from here' : 'Preparing presentation…'}
              </button>
            : <button className="stop" onClick={stop}>■ Stop presentation</button>}
        </div>
      </header>

      <section className="layout">
        <div className="slides">
          <div className="slide-image">
            <img src={deck.slides[slide].image} alt={'Slide ' + (slide + 1) + ': ' + deck.slides[slide].title} />
            {loadingText && (
              <div className="loading-overlay" role="status" aria-live="polite">
                <span className="spinner" />
                <strong>{loadingText}</strong>
                {!deckReady && prepProgress.total > 0
                  ? <small>{prepProgress.done} / {prepProgress.total} voice segments · {prepPercent}%</small>
                  : <small>Please wait a moment.</small>}
              </div>
            )}
          </div>

          <div className="pager">
            <button disabled={slide === 0 || running} onClick={() => selectSlide(slide - 1)}>← Previous</button>
            <span>{slide + 1} / {deck.slides.length}</span>
            <button disabled={slide === deck.slides.length - 1 || running} onClick={() => selectSlide(slide + 1)}>Next →</button>
          </div>

          <div className="slide-tabs">
            {deck.slides.map((item, index) => (
              <button
                key={index}
                disabled={running}
                className={index === slide ? 'selected' : ''}
                onClick={() => selectSlide(index)}
                title={item.title}
              >
                {index + 1}. {item.title}
              </button>
            ))}
          </div>
        </div>

        <aside className="conversation">
          <h2>Conversation</h2>
          <div className="messages" aria-live="polite">
            {messages.length === 0 && (
              <p className="muted">
                {deckReady
                  ? 'Ready. Click Present from here.'
                  : 'Preparing narration and voice. This is cached for later sessions.'}
              </p>
            )}
            {messages.map((message, index) => (
              <div key={index} className="message">
                <small>{message.role}{message.slide ? ' · Slide ' + message.slide : ''}</small>
                <p>{message.text}</p>
              </div>
            ))}
          </div>

          {error && <p role="alert" className="error">{error}</p>}

          <form className="ask" onSubmit={event => { event.preventDefault(); void ask(question); }}>
            <input
              value={question}
              onChange={event => setQuestion(event.target.value)}
              placeholder={running ? 'Speak to interrupt the presenter…' : 'Ask about this presentation…'}
              aria-label="Ask a question"
              disabled={running}
            />
            <button type="submit" disabled={!question.trim() || running}>Ask</button>
          </form>
        </aside>
      </section>
    </main>
  );
}
