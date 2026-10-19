import { useEffect, useRef, useState } from 'react';
import { api, speechAudio, transcribeAudio, type Answer, type Deck, type DeckItem } from './api';
import { Listener, type MicStatus } from './listener';
import { Speaker } from './voice';

type Message = {
  role: 'Presenter' | 'You';
  text: string;
  slide?: number;
  narration?: boolean;
};

type PreparedSlide = {
  text: string;
  provider: string;
  audio: ArrayBuffer;
  buffer?: AudioBuffer;
};

const QUESTION_PROMPT = 'I will pause here for a moment. Any questions before I move on?';

const IGNORED_SPEECH = new Set([
  'thank you', 'thanks', 'thank you very much', 'thanks a lot',
  'okay', 'ok', 'alright', 'yes', 'no', 'great', 'cool', 'got it',
  'hmm', 'um', 'uh',
]);

function cleanSpeech(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
}

function looksLikeEcho(question: string, spokenText: string) {
  const questionText = cleanSpeech(question);
  const sourceText = cleanSpeech(spokenText);
  if (!questionText || !sourceText) return false;
  if (questionText.length >= 14 && sourceText.includes(questionText)) return true;

  const questionWords = [...new Set(questionText.split(' ').filter(word => word.length > 2))];
  if (questionWords.length < 3) return false;
  const sourceWords = new Set(sourceText.split(' '));
  const overlap = questionWords.filter(word => sourceWords.has(word)).length;
  return overlap / questionWords.length >= 0.72;
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
  const [micStatus, setMicStatus] = useState<MicStatus>('Mic off');
  const [loadingText, setLoadingText] = useState('');

  const active = useRef<AbortController | null>(null);
  const prefetchController = useRef<AbortController | null>(null);
  const current = useRef(0);
  const messagesRef = useRef<Message[]>([]);
  const lastTranscript = useRef({ text: '', at: 0 });
  const voiceEnabled = useRef(false);
  const speaker = useRef(new Speaker());
  const listener = useRef(new Listener(setMicStatus));
  const prepared = useRef(new Map<number, PreparedSlide>());
  const preparing = useRef(new Map<number, Promise<PreparedSlide>>());
  const questionPrompt = useRef<Promise<AudioBuffer> | null>(null);

  useEffect(() => {
    api<DeckItem[]>('/api/decks').then(setDecks).catch(err => setError(err.message));
    return () => {
      active.current?.abort();
      prefetchController.current?.abort();
      speaker.current.stop();
      listener.current.close();
    };
  }, []);

  useEffect(() => {
    if (!deck) return;

    prefetchController.current?.abort();
    prefetchController.current = new AbortController();
    prepared.current.clear();
    preparing.current.clear();
    questionPrompt.current = null;

    // Hide most of the first-slide delay before the user presses Present.
    void ensurePrepared(0).catch(() => {});
    return () => prefetchController.current?.abort();
  }, [deck?.id]);

  function addMessage(message: Message) {
    messagesRef.current = [...messagesRef.current, message];
    setMessages(messagesRef.current);
  }

  function stop() {
    active.current?.abort();
    active.current = null;
    speaker.current.stop();
    listener.current.close();
    voiceEnabled.current = false;
    setRunning(false);
    setBusy(false);
    setLoadingText('');
    questionPrompt.current = null;
  }

  async function openDeck(id: string) {
    stop();
    setError('');
    setBusy(true);
    try {
      const picked = await api<Deck>('/api/decks/' + id);
      setDeck(picked);
      setSlide(0);
      current.current = 0;
      messagesRef.current = [];
      setMessages([]);
      setVoice('');
      setMicStatus('Mic off');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load presentation');
    } finally {
      setBusy(false);
    }
  }

  function selectSlide(index: number) {
    stop();
    const next = Math.max(0, Math.min(index, (deck?.slides.length || 1) - 1));
    current.current = next;
    setSlide(next);
    void ensurePrepared(next).catch(() => {});
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

  function usableTranscript(text: string, spokenText = '') {
    const cleaned = cleanSpeech(text);
    if (!cleaned || IGNORED_SPEECH.has(cleaned)) return '';
    if (spokenText && looksLikeEcho(text, spokenText)) return '';

    const now = Date.now();
    if (cleaned === lastTranscript.current.text && now - lastTranscript.current.at < 10000) return '';
    lastTranscript.current = { text: cleaned, at: now };
    return text.trim();
  }

  async function transcribeQuestion(audio: Blob, signal: AbortSignal, spokenText = '') {
    const text = await transcribeAudio(audio, signal);
    return usableTranscript(text, spokenText);
  }

  function ensurePrepared(index: number): Promise<PreparedSlide> {
    if (!deck || index < 0 || index >= deck.slides.length) {
      return Promise.reject(new Error('Invalid slide'));
    }

    const cached = prepared.current.get(index);
    if (cached) return Promise.resolve(cached);

    const pending = preparing.current.get(index);
    if (pending) return pending;

    prefetchController.current ||= new AbortController();
    const signal = prefetchController.current.signal;
    const request = (async () => {
      const narration = await api<{ text: string; provider: string }>('/api/narrate', {
        deck_id: deck.id,
        slide_index: index,
      }, signal);
      const audio = await speechAudio(narration.text, signal);
      const value: PreparedSlide = { ...narration, audio };
      prepared.current.set(index, value);
      return value;
    })();

    preparing.current.set(index, request);
    void request.then(
      () => preparing.current.delete(index),
      () => preparing.current.delete(index),
    );
    return request;
  }

  async function preparedForPlayback(index: number) {
    const cached = prepared.current.get(index);
    if (cached) return cached;

    setLoadingText('Preparing slide ' + (index + 1) + ' narration…');
    try {
      return await ensurePrepared(index);
    } finally {
      setLoadingText('');
    }
  }

  function warmNext(index: number) {
    for (const next of [index + 1, index + 2]) {
      if (deck && next < deck.slides.length) void ensurePrepared(next).catch(() => {});
    }

    // Keep memory bounded: current slide, one behind, and two ahead.
    for (const key of prepared.current.keys()) {
      if (key < index - 1 || key > index + 2) prepared.current.delete(key);
    }
  }

  async function decodeSlide(item: PreparedSlide) {
    item.buffer ||= await speaker.current.decode(item.audio);
    return item.buffer;
  }

  async function getQuestionPrompt(signal: AbortSignal) {
    questionPrompt.current ||= speaker.current.prepare(QUESTION_PROMPT, signal);
    return questionPrompt.current;
  }

  async function answerQuestion(text: string, controller: AbortController, depth = 0) {
    if (!deck || !text || controller.signal.aborted) return;

    const history = recentHistory();
    addMessage({ role: 'You', text });
    setBusy(true);
    setLoadingText('Finding the relevant slide…');

    const reply = await api<Answer>('/api/ask', {
      deck_id: deck.id,
      current_slide: current.current,
      question: text,
      history,
    }, controller.signal);

    if (controller.signal.aborted) return;

    // The user sees the referenced slide before the answer starts.
    current.current = reply.slide_index;
    setSlide(reply.slide_index);
    addMessage({ role: 'Presenter', text: reply.answer, slide: reply.slide_number });

    setLoadingText('Preparing the answer…');
    const answerBuffer = await speaker.current.prepare(reply.answer, controller.signal);
    setLoadingText('');
    setBusy(false);

    if (voiceEnabled.current && depth < 2) {
      await playWithBargeIn(answerBuffer, reply.answer, reply.slide_index, controller, depth + 1);
    } else {
      await speaker.current.play(answerBuffer, controller.signal, 0, setVoice);
    }
  }

  async function playWithBargeIn(
    buffer: AudioBuffer,
    spokenText: string,
    originSlide: number,
    controller: AbortController,
    depth = 0,
  ) {
    let offset = 0;

    while (!controller.signal.aborted && offset < buffer.duration - 0.03) {
      if (!voiceEnabled.current) {
        await speaker.current.play(buffer, controller.signal, offset, setVoice);
        return;
      }

      const listenController = new AbortController();
      const cancelListener = () => listenController.abort();
      controller.signal.addEventListener('abort', cancelListener, { once: true });

      const listenPromise = listener.current.listen(listenController.signal, {
        mode: 'barge',
        timeoutMs: Math.ceil((buffer.duration - offset + 2) * 1000),
        onSpeechStart: () => { speaker.current.pause(); },
      });

      let playback;
      try {
        playback = await speaker.current.play(buffer, controller.signal, offset, setVoice);
      } finally {
        controller.signal.removeEventListener('abort', cancelListener);
      }

      if (playback.completed) {
        listenController.abort();
        await listenPromise.catch(() => null);
        return;
      }

      const audio = await listenPromise;
      offset = playback.offset;
      if (!audio || controller.signal.aborted) continue;

      setLoadingText('Listening…');
      const question = await transcribeQuestion(audio, controller.signal, spokenText);
      setLoadingText('');

      if (!question) continue;

      await answerQuestion(question, controller, depth);

      // Return to the interrupted slide and continue from the exact audio offset.
      current.current = originSlide;
      setSlide(originSlide);
    }
  }

  async function questionBreak(controller: AbortController, isLastSlide: boolean) {
    if (!voiceEnabled.current || controller.signal.aborted) return;

    try {
      const prompt = await getQuestionPrompt(controller.signal);
      await speaker.current.play(prompt, controller.signal, 0, setVoice);
    } catch (err) {
      if (controller.signal.aborted) return;
    }

    if (controller.signal.aborted) return;

    const audio = await listener.current.listen(controller.signal, {
      mode: 'question',
      timeoutMs: isLastSlide ? 6500 : 4000,
    });
    if (!audio || controller.signal.aborted) return;

    setLoadingText('Listening…');
    const text = await transcribeQuestion(audio, controller.signal);
    setLoadingText('');
    if (text) await answerQuestion(text, controller);
  }

  async function present() {
    if (!deck || running) return;

    speaker.current.unlock();
    setError('');
    setRunning(true);
    setLoadingText('Starting presenter…');

    const controller = new AbortController();
    active.current = controller;

    const micReady = listener.current.open()
      .then(() => { voiceEnabled.current = true; })
      .catch(() => {
        voiceEnabled.current = false;
        setMicStatus('Mic off');
        setError('Microphone is unavailable. The presentation will continue without voice interruptions.');
      });

    // Prepare the Q&A prompt in the background; it will be reused.
    void getQuestionPrompt(controller.signal).catch(() => { questionPrompt.current = null; });

    try {
      const start = current.current;
      const firstSlide = preparedForPlayback(start);
      await Promise.all([micReady, firstSlide.then(() => undefined)]);
      setLoadingText('');

      for (let index = start; index < deck.slides.length; index++) {
        if (controller.signal.aborted) break;

        current.current = index;
        setSlide(index);
        setBusy(true);

        const item = await preparedForPlayback(index);
        if (controller.signal.aborted) break;

        const buffer = await decodeSlide(item);
        addMessage({
          role: 'Presenter',
          text: item.text,
          slide: index + 1,
          narration: true,
        });
        setBusy(false);

        // While this slide is speaking, generate narration + voice for the next two.
        warmNext(index);

        await playWithBargeIn(buffer, item.text, index, controller);
        if (controller.signal.aborted) break;

        const isLast = index === deck.slides.length - 1;
        const questionCheckpoint = (index - start + 1) % 2 === 0 || isLast;
        if (questionCheckpoint) {
          await questionBreak(controller, isLast);
          if (controller.signal.aborted) break;
          current.current = index;
          setSlide(index);
        }

        if (!isLast) {
          current.current = index + 1;
          setSlide(index + 1);
        }
      }
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Could not continue the presentation');
      }
    } finally {
      if (active.current === controller) active.current = null;
      speaker.current.stop();
      listener.current.close();
      voiceEnabled.current = false;
      setRunning(false);
      setBusy(false);
      setLoadingText('');
    }
  }

  async function ask(rawQuestion: string) {
    const text = rawQuestion.trim();
    if (!deck || !text || running) return;

    stop();
    speaker.current.unlock();
    setQuestion('');
    setError('');

    const controller = new AbortController();
    active.current = controller;
    setRunning(true);

    try {
      await answerQuestion(text, controller);
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Unable to answer');
      }
    } finally {
      if (active.current === controller) active.current = null;
      setRunning(false);
      setBusy(false);
      setLoadingText('');
    }
  }

  async function askByVoice() {
    if (!deck || running) return;

    const controller = new AbortController();
    active.current = controller;
    setError('');

    try {
      await listener.current.open();
      voiceEnabled.current = true;
      const audio = await listener.current.listen(controller.signal, {
        mode: 'question',
        timeoutMs: 8000,
      });
      if (!audio || controller.signal.aborted) return;

      const text = await transcribeQuestion(audio, controller.signal);
      if (text) await answerQuestion(text, controller);
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Could not use the microphone');
      }
    } finally {
      if (active.current === controller) active.current = null;
      listener.current.close();
      voiceEnabled.current = false;
      setRunning(false);
      setBusy(false);
      setLoadingText('');
    }
  }

  if (!deck) return (
    <main className="home">
      <h1>Voice Presenter</h1>
      <p>Choose a presentation. Slides are prepared ahead so the presentation can keep moving.</p>
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
        <button onClick={() => { stop(); setDeck(null); }}>← Back</button>
        <div className="heading">
          <strong>{deck.title}</strong>
          <small>Slide {slide + 1} of {deck.slides.length}{voice ? ' · ' + voice : ''} · {micStatus}</small>
        </div>
        <div className="actions">
          {!running
            ? <button className="primary" onClick={() => void present()}>▶ Present from here</button>
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
                <small>Gemini is preparing the presenter.</small>
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
            {messages.length === 0 && <p className="muted">Click Present from here to start.</p>}
            {messages.map((message, index) => (
              <div key={index} className="message">
                <small>{message.role}{message.slide ? ' · Slide ' + message.slide : ''}</small>
                <p>{message.text}</p>
              </div>
            ))}
            {busy && <p className="muted">{loadingText || 'Working…'}</p>}
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
            <button type="submit" disabled={!question.trim() || busy || running}>Ask</button>
            <button type="button" onClick={() => void askByVoice()} disabled={running} title="Ask by voice">🎙 Ask</button>
          </form>
        </aside>
      </section>
    </main>
  );
}
