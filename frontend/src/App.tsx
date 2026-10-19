import { useEffect, useRef, useState } from 'react';
import { api, type Answer, type Deck, type DeckItem } from './api';
import { Speaker } from './voice';

type Message = { role: 'Presenter' | 'You'; text: string; slide?: number };

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
  const abort = useRef<AbortController | null>(null);
  const speaker = useRef(new Speaker());
  const speechRecognition = useRef<any>(null);
  const current = useRef(0);

  useEffect(() => {
    api<DeckItem[]>('/api/decks').then(setDecks).catch(e => setError(e.message));
    return () => { abort.current?.abort(); speaker.current.stop(); speechRecognition.current?.abort?.(); };
  }, []);

  function stop() {
    abort.current?.abort();
    abort.current = null;
    speaker.current.stop();
    speechRecognition.current?.stop?.();
    setRunning(false);
    setBusy(false);
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
      setMessages([]);
      setVoice('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load presentation');
    } finally {
      setBusy(false);
    }
  }

  function selectSlide(index: number) {
    stop();
    setSlide(index);
    current.current = index;
  }

  async function present() {
    if (!deck || running) return;
    speaker.current.unlock();
    stop();
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    setBusy(true);
    setError('');
    for (let index = current.current; index < deck.slides.length; index++) {
      if (controller.signal.aborted) break;
      current.current = index;
      setSlide(index);
      try {
        const result = await api<{ text: string; provider: string }>('/api/narrate',
          { deck_id: deck.id, slide_index: index }, controller.signal);
        if (controller.signal.aborted) break;
        setMessages(old => [...old, { role: 'Presenter', text: result.text, slide: index + 1 }]);
        setBusy(false);
        await speaker.current.speak(result.text, controller.signal, setVoice);
      } catch (err) {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : 'Could not present this slide');
          controller.abort();
        }
        break;
      }
      if (controller.signal.aborted) break;
      current.current = Math.min(index + 1, deck.slides.length - 1);
      setBusy(true);
    }
    if (abort.current === controller) {
      abort.current = null;
      setRunning(false);
      setBusy(false);
    }
  }

  async function ask(rawQuestion: string) {
    const text = rawQuestion.trim();
    if (!deck || !text) return;
    speaker.current.unlock();
    stop();
    const controller = new AbortController();
    abort.current = controller;
    setQuestion('');
    setError('');
    setBusy(true);
    setMessages(old => [...old, { role: 'You', text }]);
    try {
      const reply = await api<Answer>('/api/ask',
        { deck_id: deck.id, current_slide: current.current, question: text }, controller.signal);
      if (controller.signal.aborted) return;
      setSlide(reply.slide_index);
      current.current = reply.slide_index;
      setMessages(old => [...old, { role: 'Presenter', text: reply.answer, slide: reply.slide_number }]);
      setBusy(false);
      setRunning(true);
      await speaker.current.speak(reply.answer, controller.signal, setVoice);
    } catch (err) {
      if (!controller.signal.aborted) setError(err instanceof Error ? err.message : 'Unable to answer');
    } finally {
      if (abort.current === controller) {
        abort.current = null;
        setRunning(false);
        setBusy(false);
      }
    }
  }

  function listen() {
    const Speech = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Speech) {
      setError('Voice input is not supported by this browser. You can type a question below.');
      return;
    }
    stop();
    const recognition = new Speech();
    speechRecognition.current = recognition;
    recognition.lang = 'en-IN';
    recognition.interimResults = false;
    recognition.onresult = (event: any) => void ask(event.results[0][0].transcript);
    recognition.onerror = (event: any) => setError('Microphone error: ' + event.error);
    recognition.onend = () => { if (speechRecognition.current === recognition) speechRecognition.current = null; };
    setError('');
    recognition.start();
  }

  if (!deck) return (
    <main className="home">
      <h1>Voice Presenter</h1>
      <p>Choose a presentation. Listen to each slide or ask a question to find the relevant slide.</p>
      {error && <p role="alert" className="error">{error}</p>}
      <div className="decks">
        {decks.map(item => <button key={item.id} className="deck" disabled={busy} onClick={() => void openDeck(item.id)}>
          <img src={item.cover} alt={`${item.title} cover`} />
          <strong>{item.title}</strong>
          <span>{item.slide_count} slides</span>
          <p>{item.description}</p>
        </button>)}
      </div>
    </main>
  );

  return (
    <main className="presenter">
      <header className="toolbar">
        <button onClick={() => { stop(); setDeck(null); }}>← Back</button>
        <div className="heading"><strong>{deck.title}</strong><small>Slide {slide + 1} of {deck.slides.length}{voice ? ` · ${voice}` : ''}</small></div>
        <div className="actions">
          {!running ? <button className="primary" onClick={() => void present()}>▶ Present from here</button>
            : <button className="stop" onClick={stop}>■ Stop presentation</button>}
        </div>
      </header>
      <section className="layout">
        <div className="slides">
          <div className="slide-image"><img src={deck.slides[slide].image} alt={`Slide ${slide + 1}: ${deck.slides[slide].title}`} /></div>
          <div className="pager">
            <button disabled={slide === 0} onClick={() => selectSlide(slide - 1)}>← Previous</button>
            <span>{slide + 1} / {deck.slides.length}</span>
            <button disabled={slide === deck.slides.length - 1} onClick={() => selectSlide(slide + 1)}>Next →</button>
          </div>
          <div className="slide-tabs">
            {deck.slides.map((item, i) => <button key={i} className={i === slide ? 'selected' : ''}
              onClick={() => selectSlide(i)} title={item.title}>{i + 1}. {item.title}</button>)}
          </div>
        </div>
        <aside className="conversation">
          <h2>Conversation</h2>
          <div className="messages" aria-live="polite">
            {messages.length === 0 && <p className="muted">Click Present to hear the slides or ask a question.</p>}
            {messages.map((message, i) => <div key={i} className="message">
              <small>{message.role}{message.slide ? ` · Slide ${message.slide}` : ''}</small>
              <p>{message.text}</p>
            </div>)}
            {busy && <p className="muted">Working…</p>}
          </div>
          {error && <p role="alert" className="error">{error}</p>}
          <form className="ask" onSubmit={event => { event.preventDefault(); void ask(question); }}>
            <input value={question} onChange={event => setQuestion(event.target.value)} placeholder="Ask about this presentation…" aria-label="Ask a question" />
            <button type="submit" disabled={!question.trim() || busy}>Ask</button>
            <button type="button" onClick={listen} title="Ask using microphone" aria-label="Ask using microphone">🎙</button>
          </form>
        </aside>
      </section>
    </main>
  );
}
