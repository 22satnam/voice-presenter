import { useEffect, useRef, useState } from 'react';
import { api, transcribeAudio, type Answer, type Deck, type DeckItem } from './api';
import { Listener, type MicStatus } from './listener';
import { Speaker } from './voice';

type Message = {
  role: 'Presenter' | 'You';
  text: string;
  slide?: number;
  narration?: boolean;
};

const IGNORED_SPEECH = new Set([
  'thank you', 'thanks', 'thank you very much', 'thanks a lot',
  'okay', 'ok', 'alright', 'yes', 'no', 'great', 'cool', 'got it',
  'hmm', 'um', 'uh',
]);

function cleanSpeech(text: string) {
  return text.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
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

  const active = useRef<AbortController | null>(null);
  const current = useRef(0);
  const messagesRef = useRef<Message[]>([]);
  const lastTranscript = useRef({ text: '', at: 0 });
  const speaker = useRef(new Speaker());
  const listener = useRef(new Listener(setMicStatus));

  useEffect(() => {
    api<DeckItem[]>('/api/decks').then(setDecks).catch(err => setError(err.message));
    return () => {
      active.current?.abort();
      speaker.current.stop();
      listener.current.close();
    };
  }, []);

  function addMessage(message: Message) {
    messagesRef.current = [...messagesRef.current, message];
    setMessages(messagesRef.current);
  }

  function stop() {
    active.current?.abort();
    active.current = null;
    speaker.current.stop();
    listener.current.close();
    setRunning(false);
    setBusy(false);
  }

  async function openDeck(id: string) {
    stop();
    listener.current.close();
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

  function usableTranscript(text: string) {
    const cleaned = cleanSpeech(text);
    if (!cleaned || IGNORED_SPEECH.has(cleaned)) return '';
    const now = Date.now();
    if (cleaned === lastTranscript.current.text && now - lastTranscript.current.at < 10000) return '';
    lastTranscript.current = { text: cleaned, at: now };
    return text.trim();
  }

  async function transcribeQuestion(audio: Blob, signal: AbortSignal) {
    setMicStatus('Ready');
    const text = await transcribeAudio(audio, signal);
    return usableTranscript(text);
  }

  async function answerQuestion(text: string, signal: AbortSignal) {
    if (!deck || !text || signal.aborted) return;

    const history = recentHistory();
    addMessage({ role: 'You', text });
    setBusy(true);

    const reply = await api<Answer>('/api/ask', {
      deck_id: deck.id,
      current_slide: current.current,
      question: text,
      history,
    }, signal);

    if (signal.aborted) return;

    // Show the relevant slide before the answer is spoken.
    current.current = reply.slide_index;
    setSlide(reply.slide_index);
    addMessage({ role: 'Presenter', text: reply.answer, slide: reply.slide_number });
    setBusy(false);

    await speaker.current.speak(reply.answer, signal, setVoice);
  }

  async function questionBreak(controller: AbortController, isLastSlide: boolean) {
    if (!deck || controller.signal.aborted) return;

    const invitation = isLastSlide
      ? 'That brings us to the end of the presentation. Any questions?'
      : 'I will pause here for a moment. Any questions before I move on?';

    await speaker.current.speak(invitation, controller.signal, setVoice);
    if (controller.signal.aborted) return;

    let audio: Blob | null = null;
    try {
      audio = await listener.current.listenOnce(controller.signal, isLastSlide ? 7000 : 5000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Microphone could not start');
      setMicStatus('Mic off');
      return;
    }

    if (!audio || controller.signal.aborted) return;

    try {
      const text = await transcribeQuestion(audio, controller.signal);
      if (text) await answerQuestion(text, controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Could not understand the question');
      }
    }
  }

  async function present() {
    if (!deck || running) return;

    speaker.current.unlock();
    setError('');
    let voiceQuestions = false;
    try {
      await listener.current.open();
      voiceQuestions = true;
    } catch (err) {
      setMicStatus('Mic off');
      setError('Microphone is unavailable, so voice questions are off. The presentation will still continue.');
    }

    const controller = new AbortController();
    active.current = controller;
    setRunning(true);

    const start = current.current;
    for (let index = start; index < deck.slides.length; index++) {
      if (controller.signal.aborted) break;

      current.current = index;
      setSlide(index);
      setBusy(true);

      try {
        const result = await api<{ text: string; provider: string }>('/api/narrate', {
          deck_id: deck.id,
          slide_index: index,
        }, controller.signal);

        if (controller.signal.aborted) break;

        addMessage({
          role: 'Presenter',
          text: result.text,
          slide: index + 1,
          narration: true,
        });
        setBusy(false);

        await speaker.current.speak(result.text, controller.signal, setVoice);
        if (controller.signal.aborted) break;

        const isLast = index === deck.slides.length - 1;
        const questionCheckpoint = (index - start + 1) % 2 === 0 || isLast;

        if (questionCheckpoint && voiceQuestions) {
          await questionBreak(controller, isLast);
          if (controller.signal.aborted) break;
        }

        // The Q&A may temporarily show another slide. Continue from the deck sequence.
        if (!isLast) {
          current.current = index + 1;
          setSlide(index + 1);
        }
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : 'Could not present this slide');
          controller.abort();
        }
        break;
      }
    }

    if (active.current === controller) active.current = null;
    setRunning(false);
    setBusy(false);
    listener.current.close();
  }

  async function ask(rawQuestion: string) {
    const text = rawQuestion.trim();
    if (!deck || !text) return;

    stop();
    speaker.current.unlock();
    setQuestion('');
    setError('');

    const controller = new AbortController();
    active.current = controller;
    setRunning(true);

    try {
      await answerQuestion(text, controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Unable to answer');
      }
    } finally {
      if (active.current === controller) active.current = null;
      setRunning(false);
      setBusy(false);
    }
  }

  async function askByVoice() {
    if (!deck || running) return;

    const controller = new AbortController();
    active.current = controller;
    setError('');

    try {
      await listener.current.open();
      const audio = await listener.current.listenOnce(controller.signal, 8000);
      if (!audio || controller.signal.aborted) return;
      const text = await transcribeQuestion(audio, controller.signal);
      if (text) await answerQuestion(text, controller.signal);
    } catch (err) {
      if (!controller.signal.aborted) {
        setError(err instanceof Error ? err.message : 'Could not use the microphone');
      }
    } finally {
      if (active.current === controller) active.current = null;
      setRunning(false);
      setBusy(false);
      if (micStatus !== 'Mic off') setMicStatus('Ready');
    }
  }

  if (!deck) return (
    <main className="home">
      <h1>Voice Presenter</h1>
      <p>Choose a presentation. It will present the slides in order and pause for questions as it goes.</p>
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
        <button onClick={() => { stop(); listener.current.close(); setDeck(null); }}>← Back</button>
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
            {busy && <p className="muted">Working…</p>}
          </div>

          {error && <p role="alert" className="error">{error}</p>}

          <form className="ask" onSubmit={event => { event.preventDefault(); void ask(question); }}>
            <input
              value={question}
              onChange={event => setQuestion(event.target.value)}
              placeholder="Ask about this presentation…"
              aria-label="Ask a question"
            />
            <button type="submit" disabled={!question.trim() || busy}>Ask</button>
            <button type="button" onClick={() => void askByVoice()} disabled={running} title="Ask by voice">🎙 Ask</button>
          </form>
        </aside>
      </section>
    </main>
  );
}
