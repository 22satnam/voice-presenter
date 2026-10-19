import { useEffect, useRef, useState } from 'react';
import { api, transcribeAudio, type Answer, type Deck, type DeckItem } from './api';
import { Speaker } from './voice';
import { Listener } from './listener';

type Message = { role: 'Presenter' | 'You'; text: string; slide?: number; kind?: 'narration' };

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
  const [micStatus, setMicStatus] = useState('Mic off');
  const [messagesRef] = useState(() => ({ current: [] as Message[] }));
  const abort = useRef<AbortController | null>(null);
  const speaker = useRef(new Speaker());
  const listener = useRef<Listener | null>(null);
  const transcription = useRef<AbortController | null>(null);
  const current = useRef(0);

  const askRef = useRef<(text: string) => void>(() => {});

  useEffect(() => {
    api<DeckItem[]>('/api/decks').then(setDecks).catch(e => setError(e.message));
    return () => { abort.current?.abort(); transcription.current?.abort(); speaker.current.stop(); listener.current?.stop(); };
  }, []);

  function stop() {
    abort.current?.abort();
    abort.current = null;
    speaker.current.stop();
    transcription.current?.abort();
    setRunning(false);
    setBusy(false);
  }

  async function openDeck(id: string) {
    stop();
    setError('');
    speaker.current.unlock();
    startListening();
    setBusy(true);
    try {
      const picked = await api<Deck>('/api/decks/' + id);
      setDeck(picked);
      setSlide(0);
      current.current = 0;
      messagesRef.current = [];
      setMessages([]);
      setVoice('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load presentation');
    } finally {
      setBusy(false);
    }
  }

  function addMessage(message: Message) {
    messagesRef.current = [...messagesRef.current, message];
    setMessages(messagesRef.current);
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
        addMessage({ role: 'Presenter', text: result.text, slide: index + 1, kind: 'narration' });
        setBusy(false);
        listener.current?.pause(true);
        try { await speaker.current.speak(result.text, controller.signal, setVoice); }
        finally { listener.current?.pause(false); }
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
    const normalized = text.toLowerCase().replace(/[.!?]+$/, '').trim();
    if (/^(stop|stop presentation|stop presenting|pause presentation)$/.test(normalized)) { stop(); return; }
    if (/^(next slide|next|go forward)$/.test(normalized)) { selectSlide(Math.min(current.current + 1, deck.slides.length - 1)); return; }
    if (/^(previous slide|previous|go back)$/.test(normalized)) { selectSlide(Math.max(current.current - 1, 0)); return; }
    const requested = normalized.match(/^(?:go to|open|show|jump to) slide (\d+)$/);
    if (requested) { selectSlide(Math.max(0, Math.min(Number(requested[1]) - 1, deck.slides.length - 1))); return; }
    speaker.current.unlock();
    stop();
    const controller = new AbortController();
    abort.current = controller;
    setQuestion('');
    setError('');
    setBusy(true);
    const history = messagesRef.current.filter(m => m.kind !== 'narration')
      .slice(-6).map(m => ({ role: m.role === 'You' ? 'user' : 'assistant', text: m.text }));
    addMessage({ role: 'You', text });
    try {
      const reply = await api<Answer>('/api/ask',
        { deck_id: deck.id, current_slide: current.current, question: text, history }, controller.signal);
      if (controller.signal.aborted) return;
      setSlide(reply.slide_index);
      current.current = reply.slide_index;
      addMessage({ role: 'Presenter', text: reply.answer, slide: reply.slide_number });
      setBusy(false);
      setRunning(true);
      listener.current?.pause(true);
      try { await speaker.current.speak(reply.answer, controller.signal, setVoice); }
      finally { listener.current?.pause(false); }
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

  function startListening() {
    listener.current ||= new Listener(async audio => {
      const controller = new AbortController();
      transcription.current = controller;
      try {
        const text = await transcribeAudio(audio, controller.signal);
        if (!controller.signal.aborted && text.trim()) askRef.current(text.trim());
      } finally {
        if (transcription.current === controller) transcription.current = null;
      }
    }, setMicStatus, message => setError(message));

    void listener.current.start().catch(error => {
      setMicStatus('Mic off');
      setError(error instanceof Error ? error.message : 'Microphone could not start');
    });
  }

  function stopListening() {
    transcription.current?.abort();
    listener.current?.stop();
    setMicStatus('Mic off');
  }

  function toggleMic() {
    if (micStatus !== 'Mic off') stopListening();
    else { setError(''); startListening(); }
  }
  askRef.current = text => { void ask(text); };

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
        <button onClick={() => { stop(); stopListening(); setDeck(null); }}>← Back</button>
        <div className="heading"><strong>{deck.title}</strong><small>Slide {slide + 1} of {deck.slides.length}{voice ? ` · ${voice}` : ''}{` · ${micStatus}`}</small></div>
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
            <button type="button" onClick={toggleMic} title={micStatus !== 'Mic off' ? 'Turn microphone off' : 'Turn microphone on'} aria-label={micStatus !== 'Mic off' ? 'Turn microphone off' : 'Turn microphone on'}>{micStatus !== 'Mic off' ? '🎙 On' : '🎙 Off'}</button>
          </form>
        </aside>
      </section>
    </main>
  );
}
