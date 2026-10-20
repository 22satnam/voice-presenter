import { useEffect, useRef, useState } from "react";
import { api, type Deck, type DeckItem } from "./api";
import { VoicePresenterSession } from "./live";

type Message = {
  role: "You" | "Presenter";
  text: string;
  slide?: number;
};

export default function App() {
  const [decks, setDecks] = useState<DeckItem[]>([]);
  const [deck, setDeck] = useState<Deck | null>(null);
  const [slide, setSlide] = useState(0);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("Ready");
  const [loading, setLoading] = useState("");
  const [error, setError] = useState("");
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [liveTranscript, setLiveTranscript] = useState("");

  const live = useRef<VoicePresenterSession | null>(null);
  const presentationSlide = useRef(0);
  const questionActive = useRef(false);
  const resumeSlide = useRef<number | null>(null);
  const advanceTimer = useRef<number | null>(null);
  const lastUserText = useRef("");
  const runningRef = useRef(false);

  useEffect(() => {
    api<DeckItem[]>("/api/decks")
      .then(setDecks)
      .catch(err => setError(err.message));

    return () => {
      window.clearTimeout(advanceTimer.current || undefined);
      live.current?.close();
    };
  }, []);

  function addMessage(message: Message) {
    setMessages(old => [...old, message]);
  }

  function clearAdvanceTimer() {
    if (advanceTimer.current) {
      window.clearTimeout(advanceTimer.current);
      advanceTimer.current = null;
    }
  }

  async function openDeck(id: string) {
    stop();
    setError("");
    setLoading("Loading presentation…");

    try {
      const picked = await api<Deck>("/api/decks/" + id);
      setDeck(picked);
      setSlide(0);
      presentationSlide.current = 0;
      setMessages([]);
      setLiveTranscript("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load presentation");
    } finally {
      setLoading("");
    }
  }

  function sendSlide(index: number, resume = false) {
    if (!deck || !live.current || index < 0 || index >= deck.slides.length) return;

    clearAdvanceTimer();
    presentationSlide.current = index;
    setSlide(index);
    setLiveTranscript("");
    setStatus(resume ? "Resuming slide " + (index + 1) : "Presenting slide " + (index + 1));
    live.current.sendPresentationSlide(index, resume);
  }

  function scheduleNextSlide() {
    if (!deck || !runningRef.current) return;
    const next = presentationSlide.current + 1;

    if (next >= deck.slides.length) {
      setStatus("Presentation complete · listening for questions");
      return;
    }

    clearAdvanceTimer();
    advanceTimer.current = window.setTimeout(() => {
      advanceTimer.current = null;
      if (!questionActive.current && runningRef.current) sendSlide(next);
    }, 700);
  }

  async function present() {
    if (!deck || runningRef.current) return;

    setError("");
    setLoading("Starting voice session…");
    setStatus("Connecting…");
    setRunning(true);
    runningRef.current = true;
    questionActive.current = false;
    resumeSlide.current = null;
    clearAdvanceTimer();

    const session = new VoicePresenterSession(deck, {
      onStatus: setStatus,
      onSlide: index => setSlide(index),
      onUserActivity: () => {
        clearAdvanceTimer();
        if (runningRef.current) setStatus("Listening…");
      },
      onUserText: text => {
        const cleaned = text.trim();
        if (!cleaned || cleaned === lastUserText.current) return;
        lastUserText.current = cleaned;
        questionActive.current = true;
        clearAdvanceTimer();
        addMessage({ role: "You", text: cleaned });
      },
      onModelText: text => setLiveTranscript(text),
      onInterrupted: () => {
        clearAdvanceTimer();
        if (resumeSlide.current === null) resumeSlide.current = presentationSlide.current;
        questionActive.current = true;
        setStatus("Interrupted · listening");
      },
      onTurnComplete: (modelText, interrupted) => {
        if (!runningRef.current) return;

        if (interrupted) {
          setLiveTranscript("");
          return;
        }

        if (modelText.trim()) {
          addMessage({
            role: "Presenter",
            text: modelText.trim(),
            slide: slide + 1,
          });
        }
        setLiveTranscript("");

        if (questionActive.current) {
          questionActive.current = false;
          const resume = resumeSlide.current;
          resumeSlide.current = null;

          if (resume !== null) {
            window.setTimeout(() => {
              if (runningRef.current && !questionActive.current) sendSlide(resume, true);
            }, 300);
          } else {
            scheduleNextSlide();
          }
          return;
        }

        scheduleNextSlide();
      },
      onError: message => setError(message),
    });

    live.current = session;
    // Do this inside the Present click so Chrome/Safari allow later streamed audio.
    session.unlockAudio();

    try {
      await session.connect();
      if (!runningRef.current) return;
      setLoading("");
      sendSlide(presentationSlide.current);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the voice session");
      stop();
    }
  }

  function stop() {
    clearAdvanceTimer();
    live.current?.close();
    live.current = null;
    runningRef.current = false;
    questionActive.current = false;
    resumeSlide.current = null;
    setRunning(false);
    setLoading("");
    setStatus("Ready");
    setLiveTranscript("");
  }

  function askTyped() {
    const text = question.trim();
    if (!text || !live.current || !runningRef.current) return;

    clearAdvanceTimer();
    questionActive.current = true;
    if (resumeSlide.current === null) resumeSlide.current = presentationSlide.current;
    addMessage({ role: "You", text });
    setQuestion("");
    setStatus("Answering…");
    live.current.sendQuestion(text);
  }

  function selectSlide(index: number) {
    if (!deck || runningRef.current) return;
    const next = Math.max(0, Math.min(index, deck.slides.length - 1));
    presentationSlide.current = next;
    setSlide(next);
  }

  if (!deck) {
    return (
      <main className="home">
        <h1>Voice Presenter</h1>
        <p>Choose a presentation and start an interactive voice presentation.</p>

        {error && <p role="alert" className="error">{error}</p>}

        <div className="decks">
          {decks.map(item => (
            <button key={item.id} className="deck" onClick={() => void openDeck(item.id)}>
              <img src={item.cover} alt={item.title + " cover"} />
              <strong>{item.title}</strong>
              <span>{item.slide_count} slides</span>
              <p>{item.description}</p>
            </button>
          ))}
        </div>
      </main>
    );
  }

  return (
    <main className="presenter">
      <header className="toolbar">
        <button onClick={() => { stop(); setDeck(null); }}>← Back</button>

        <div className="heading">
          <strong>{deck.title}</strong>
          <small>Slide {slide + 1} of {deck.slides.length} · {status}</small>
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
            <img
              src={deck.slides[slide].image}
              alt={"Slide " + (slide + 1) + ": " + deck.slides[slide].title}
            />

            {loading && (
              <div className="loading-overlay" role="status" aria-live="polite">
                <span className="spinner" />
                <strong>{loading}</strong>
                <small>Opening a real-time audio session.</small>
              </div>
            )}
          </div>

          <div className="pager">
            <button disabled={slide === 0 || running} onClick={() => selectSlide(slide - 1)}>
              ← Previous
            </button>
            <span>{slide + 1} / {deck.slides.length}</span>
            <button
              disabled={slide === deck.slides.length - 1 || running}
              onClick={() => selectSlide(slide + 1)}
            >
              Next →
            </button>
          </div>

          <div className="slide-tabs">
            {deck.slides.map((item, index) => (
              <button
                key={index}
                disabled={running}
                className={index === slide ? "selected" : ""}
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
                Start the presentation, then interrupt naturally whenever you want.
              </p>
            )}

            {messages.map((message, index) => (
              <div key={index} className="message">
                <small>
                  {message.role}
                  {message.slide ? " · Slide " + message.slide : ""}
                </small>
                <p>{message.text}</p>
              </div>
            ))}

            {liveTranscript && (
              <div className="message live-message">
                <small>Presenter · speaking</small>
                <p>{liveTranscript}</p>
              </div>
            )}
          </div>

          {error && <p role="alert" className="error">{error}</p>}

          <form
            className="ask"
            onSubmit={event => {
              event.preventDefault();
              askTyped();
            }}
          >
            <input
              value={question}
              onChange={event => setQuestion(event.target.value)}
              placeholder={running ? "Ask by voice or type here…" : "Start the presentation first…"}
              disabled={!running}
            />
            <button type="submit" disabled={!running || !question.trim()}>
              Ask
            </button>
          </form>
        </aside>
      </section>
    </main>
  );
}
