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
  const [listening, setListening] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const speaker = useRef(new Speaker());
  const speechRecognition = useRef<any>(null);
  const current = useRef(0);
  const micWanted = useRef(false);
  const speaking = useRef(false);
  const askRef = useRef<(text: string) => void>(() => {});

  useEffect(() => {
    api<DeckItem[]>('/api/decks').then(setDecks).catch(e => setError(e.message));
    return () => { micWanted.current = false; abort.current?.abort(); speaker.current.stop(); speechRecognition.current?.abort?.(); };
  }, []);

  function stop() {
    abort.current?.abort();
    abort.current = null;
    speaker.current.stop();
    speaking.current = false;
    setRunning(false);
    setBusy(false);
  }

  async function openDeck(id: string) {
    stop();
    speaker.current.unlock();
    startListening();
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
        speaking.current = true;
        try { await speaker.current.speak(result.text, controller.signal, setVoice); }
        finally { speaking.current = false; }
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
      speaking.current = true;
      try { await speaker.current.speak(reply.answer, controller.signal, setVoice); }
      finally { speaking.current = false; }
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

  // Keep voice input on while a deck is open. The mic button is only needed
  // when the browser blocks automatic permission or the user turns it off.
  function startListening() {
    const Speech = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Speech) {
      setError('This browser does not support speech recognition. You can still type questions.');
      return;
    }
    micWanted.current = true;
    if (speechRecognition.current) return;
    const recognition = new Speech();
    speechRecognition.current = recognition;
    recognition.lang = 'en-IN';
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event: any) => {
      for (let i = event.resultIndex; i < event.results.length; i++) {
        if (!event.results[i].isFinal) continue;
        const heard = String(event.results[i][0].transcript || '').trim();
        if (!heard) continue;
        // Don't mistake the presenter's own audio for a question.
        // During narration say "Presenter, ..." to interrupt.
        const wake = heard.match(/^(?:hey\s+)?presenter[,.:]?\s*(.+)/i);
        if (speaking.current && !wake) continue;
        askRef.current(wake ? wake[1] : heard);
        break;
      }
    };
    recognition.onerror = (event: any) => {
      if (['not-allowed', 'service-not-allowed', 'network', 'audio-capture'].includes(event.error)) {
        micWanted.current = false;
        setListening(false);
        setError('Voice input could not start (' + event.error + '). Check microphone permission or use typed questions.');
      }
    };
    recognition.onend = () => {
      if (speechRecognition.current === recognition) speechRecognition.current = null;
      setListening(false);
      if (micWanted.current) window.setTimeout(startListening, 400);
    };
    try {
      recognition.start();
      setListening(true);
    } catch {
      speechRecognition.current = null;
      micWanted.current = false;
      setListening(false);
    }
  }

  function toggleMicOff() {
    micWanted.current = false;
    speechRecognition.current?.abort?.();
    speechRecognition.current = null;
    setListening(false);
  }

  function toggleMic() {
    if (micWanted.current) {
      toggleMicOff();
    } else {
      setError('');
      startListening();
    }
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
        <button onClick={() => { stop(); toggleMicOff(); setDeck(null); }}>← Back</button>
        <div className="heading"><strong>{deck.title}</strong><small>Slide {slide + 1} of {deck.slides.length}{voice ? ` · ${voice}` : ''}{listening ? ' · Mic on' : ' · Mic off'}</small></div>
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
            <button type="button" onClick={toggleMic} title={listening ? 'Turn microphone off' : 'Turn microphone on'} aria-label={listening ? 'Turn microphone off' : 'Turn microphone on'}>{listening ? '🎙 On' : '🎙 Off'}</button>
          </form>
        </aside>
      </section>
    </main>
  );
}
