import { useEffect, useRef, useState } from "react";
import { ArrowLeft, Hand, Mic, Play, Volume2, VolumeX, CornerDownLeft, ShieldCheck, Zap } from "lucide-react";
import type { Deck } from "@/data/decks";
import { request, streamText, telemetry, type Route, type Usage } from "@/lib/api";
import { Speaker, segmentSentences, transcribe, wavFromFloat } from "@/lib/voice";
import { matchCommand, redactPII } from "@/lib/engine";

type Mode = "idle" | "listening" | "thinking" | "speaking";
type Entry = { id: number; role: "user" | "agent" | "system"; text: string; meta?: string; interrupted?: boolean; pii?: string[]; kind?: "narration" | "answer" };
type Totals = { inTokens: number; outTokens: number; sttSeconds: number; ttsChars: number; local: number; answers: number };
type VadInstance = { start: () => void | Promise<void>; pause: () => void | Promise<void> };

const ZERO: Totals = { inTokens: 0, outTokens: 0, sttSeconds: 0, ttsChars: 0, local: 0, answers: 0 };

export function Presenter({ deck, onExit }: { deck: Deck; onExit: () => void }) {
  const [slide, setSlide] = useState(0);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [mode, setMode] = useState<Mode>("idle");
  const [autoPresent, setAutoPresent] = useState(false);
  const [resume, setResume] = useState<number | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [totals, setTotals] = useState<Totals>(ZERO);
  const [toast, setToast] = useState<string | null>(null);
  const [voiceOn, setVoiceOn] = useState(true);
  const voiceOnRef = useRef(true);
  const [input, setInput] = useState("");
  const [micLive, setMicLive] = useState(false);
  const [error, setError] = useState("");
  const [caption, setCaption] = useState("");
  const [piiAlert, setPiiAlert] = useState<string[]>([]);
  const active = useRef<AbortController | null>(null);
  const transcriptionCtl = useRef<AbortController | null>(null);
  const speaker = useRef(new Speaker());
  const vad = useRef<VadInstance | null>(null);
  const recognition = useRef<any>(null);
  const run = useRef(0);
  const modeRef = useRef<Mode>("idle");
  const slideRef = useRef(0);
  const lastEntry = useRef<number | null>(null);
  const entryNumber = useRef(0);
  const transcriptBox = useRef<HTMLDivElement>(null);
  const askRef = useRef<(text: string) => void>(() => {});
  const session = useRef(crypto.randomUUID()).current;

  const setStatus = (m: Mode) => { modeRef.current = m; setMode(m); };
  const setPage = (i: number) => {
    const n = Math.min(Math.max(i, 0), deck.slides.length - 1);
    slideRef.current = n; setSlide(n); setHighlight(null);
  };
  const addEntry = (entry: Omit<Entry, "id">) => {
    const id = ++entryNumber.current;
    setEntries((old) => [...old, { id, ...entry }]);
    return id;
  };
  const patch = (id: number, props: Partial<Entry>) => setEntries((old) => old.map((e) => e.id === id ? { ...e, ...props } : e));
  const addUsage = (usage?: Partial<Usage>) => {
    if (!usage) return;
    setTotals((t) => ({ ...t, inTokens: t.inTokens + (usage.input_tokens || 0), outTokens: t.outTokens + (usage.output_tokens || 0) }));
  };

  const stop = (reason: "voice" | "button" | "navigation" = "button") => {
    const interrupted = modeRef.current === "speaking" || modeRef.current === "thinking";
    run.current++;
    active.current?.abort(); active.current = null;
    transcriptionCtl.current?.abort(); transcriptionCtl.current = null;
    speaker.current.cancel();
    if (interrupted && lastEntry.current) patch(lastEntry.current, { interrupted: true });
    if (interrupted || autoPresent) {
      setResume(slideRef.current); setAutoPresent(false);
      telemetry(session, "interrupt", "client", { reason });
    }
    setCaption(""); setStatus("listening");
  };

  useEffect(() => { transcriptBox.current?.scrollTo({ top: transcriptBox.current.scrollHeight }); }, [entries]);
  useEffect(() => () => {
    run.current++; active.current?.abort(); transcriptionCtl.current?.abort(); speaker.current.cancel();
    vad.current?.pause(); recognition.current?.abort?.();
  }, []);

  function task(): { id: number; signal: AbortSignal } {
    stop("navigation");
    const ctl = new AbortController(); active.current = ctl;
    return { id: ++run.current, signal: ctl.signal };
  }

  function navigate(i: number, via: "local" | "click" | "router", reason?: string) {
    if (via !== "router") stop("navigation");
    const index = Math.min(Math.max(0, i), deck.slides.length - 1);
    setPage(index);
    if (via === "router") {
      setToast(`Jumped to slide ${index + 1}: ${reason || deck.slides[index].title}`);
      window.setTimeout(() => setToast(null), 3000);
    } else {
      telemetry(session, "nav", "client", { target_slide: index, source: via });
      if (via === "local") setTotals((u) => ({ ...u, local: u.local + 1 }));
    }
  }

  async function generate(path: "/api/answer" | "/api/narrate", data: unknown, signal: AbortSignal, id: number) {
    const entry = addEntry({ role: "agent", text: "", kind: path === "/api/narrate" ? "narration" : "answer" });
    lastEntry.current = entry;
    let pending = ""; let audible = ""; let produced = "";
    let queue = Promise.resolve(); let tokenInfo: Usage | undefined;
    const enqueue = (segment: string) => {
      queue = queue.then(async () => {
        if (signal.aborted || run.current !== id) return;
        const success = !voiceOnRef.current || await speaker.current.speak(segment, session, signal);
        if (signal.aborted || run.current !== id) return;
        if (!success) throw new Error("Speech playback failed. Check your browser audio output and retry.");
        audible = [audible, segment].filter(Boolean).join(" ");
        patch(entry, { text: audible });
        setCaption(audible.slice(-200));
        if (voiceOnRef.current) setTotals((u) => ({ ...u, ttsChars: u.ttsChars + segment.length }));
      });
    };
    try {
      setStatus("thinking");
      for await (const event of streamText(path, data, signal)) {
        if (signal.aborted || run.current !== id) break;
        if (event.type === "delta") {
          setStatus("speaking"); produced += event.text; pending += event.text;
          patch(entry, { text: produced });
          const parts = segmentSentences(pending);
          pending = parts.remainder;
          parts.sentences.forEach(enqueue);
        } else if (event.type === "usage") tokenInfo = event.usage;
        else if (event.type === "fallback") setToast(`Primary provider unavailable · switched to ${event.provider}`);
        else if (event.type === "error") throw new Error(event.message);
      }
      if (pending.trim()) enqueue(pending.trim());
      await queue;
      if (!produced.trim()) throw new Error("The provider returned no narration text.");
      if (!signal.aborted && run.current === id) {
        patch(entry, { text: produced });
        patch(entry, { meta: `${tokenInfo?.provider || "provider"} · ${tokenInfo?.input_tokens ?? 0} input / ${tokenInfo?.output_tokens ?? 0} output tokens` });
        addUsage(tokenInfo);
        setStatus("listening"); setCaption("");
        return true;
      }
    } catch (e) {
      if (!signal.aborted) { setError(e instanceof Error ? e.message : "Generation failed"); patch(entry, { text: produced.trim() || "Narration could not be generated.", meta: "Playback or generation failed" }); setStatus("listening"); }
    }
    return false;
  }

  async function ask(text: string) {
    const question = text.trim(); if (!question) return;
    const { id, signal } = task();
    setAutoPresent(false); setError(""); setPiiAlert([]);
    // Local command check: no model calls and zero tokens.
    const sanitizedPreview = redactPII(question).text;
    const command = matchCommand(sanitizedPreview, deck.slides.length, slideRef.current);
    if (command !== null) {
      addEntry({ role: "user", text: sanitizedPreview });
      navigate(command, "local");
      addEntry({ role: "system", text: `Opened slide ${command + 1} · 0 tokens` });
      return;
    }
    const userId = addEntry({ role: "user", text: "Checking the question for personal information…" });
    setStatus("thinking");
    try {
      const routed = await request<Route>("/api/route", { session_id: session, deck, current_slide: slideRef.current, question }, signal);
      if (signal.aborted || run.current !== id) return;
      patch(userId, { text: routed.sanitized_question, pii: routed.pii_types });
      setPiiAlert(routed.pii_types); addUsage(routed.usage);
      const target = routed.target_slide;
      if (target !== slideRef.current) navigate(target, "router", routed.reason);
      setHighlight(routed.covered ? routed.bullet : null);
      // The LLM never receives the unredacted question.
      const history = entries.slice(-6).filter((e) => e.role !== "system").map((e) => ({ role: e.role === "agent" ? "assistant" : "user", content: e.text }));
      const ok = await generate("/api/answer", {
        session_id: session, deck, question: routed.sanitized_question,
        current_slide: slideRef.current, target_slide: target, history,
      }, signal, id);
      if (ok) setTotals((u) => ({ ...u, answers: u.answers + 1 }));
    } catch (e) {
      if (!signal.aborted) { patch(userId, { text: "Question could not be processed." }); setError(e instanceof Error ? e.message : "Unable to answer"); setStatus("listening"); }
    }
  }
  askRef.current = (q) => { void ask(q); };

  async function present(start: number) {
    const { id, signal } = task();
    window.speechSynthesis?.resume();
    if (!voiceOnRef.current) { setError("Unmute audio before starting the presentation."); setAutoPresent(false); return; }
    setAutoPresent(true); setResume(null); setError("");
    for (let i = start; i < deck.slides.length; i++) {
      if (signal.aborted || run.current !== id) return;
      setPage(i);
      const success = await generate("/api/narrate", { session_id: session, deck, slide_index: i }, signal, id);
      if (!success) { setAutoPresent(false); return; }
    }
    if (!signal.aborted && run.current === id) {
      setAutoPresent(false); addEntry({ role: "system", text: "Presentation finished. Ask a question or select another slide." });
    }
  }

  async function onSpeechEnd(samples: Float32Array) {
    const controller = new AbortController(); transcriptionCtl.current = controller;
    // Speech start already interrupts existing generation. On completion, transcribe on Groq.
    try {
      setStatus("thinking");
      const clean = await transcribe(wavFromFloat(samples), session, controller.signal);
      setTotals((u) => ({ ...u, sttSeconds: u.sttSeconds + samples.length / 16000 }));
      if (controller.signal.aborted) return;
      transcriptionCtl.current = null;
      if (clean.trim()) askRef.current(clean);
      else setStatus("listening");
    } catch (e) {
      if (controller.signal.aborted) return;
      transcriptionCtl.current = null;
      vad.current?.pause(); setMicLive(false);
      if (startBrowserRecognition()) setError("Groq STT unavailable. Switched to browser speech recognition; please repeat the question.");
      else setError(`${e instanceof Error ? e.message : "STT failed"}. Type a question instead.`);
      setStatus("listening");
    }
  }

  function startBrowserRecognition(): boolean {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return false;
    try {
      const r = new SR(); recognition.current = r;
      r.lang = "en-IN"; r.continuous = true; r.interimResults = false;
      r.onspeechstart = () => { if (modeRef.current === "speaking" || modeRef.current === "thinking") stop("voice"); };
      r.onresult = (e: any) => askRef.current(e.results[e.results.length - 1][0].transcript);
      r.onerror = (event: any) => {
        setMicLive(false);
        const reason = String(event?.error || "unknown");
        const explanation = reason === "not-allowed" || reason === "service-not-allowed"
          ? "Microphone access was denied. Allow this site's microphone in browser settings and try again."
          : reason === "network" ? "The browser's speech recognition service could not connect. Configure GROQ_API_KEY for more reliable transcription."
          : reason === "audio-capture" ? "No working microphone was found. Check your audio input device and permissions."
          : reason === "no-speech" ? "No speech detected. Try again and speak closer to your microphone."
          : `Browser speech recognition failed (${reason}). Use typed input or configure GROQ_API_KEY.`;
        setError(explanation);
      };
      r.onend = () => setMicLive(false);
      r.start(); setMicLive(true); setStatus("listening");
      return true;
    } catch { return false; }
  }

  async function toggleMic() {
    if (micLive) {
      vad.current?.pause(); recognition.current?.stop?.();
      setMicLive(false); return;
    }
    setError("");
    if (!navigator.mediaDevices?.getUserMedia) {
      setError("This browser cannot access microphone devices. Use HTTPS and a supported browser, or type a question.");
      return;
    }
    try {
      if (vad.current) { await vad.current.start(); setMicLive(true); setStatus("listening"); return; }
      const { MicVAD } = await import("@ricky0123/vad-web");
      const instance = await MicVAD.new({
        model: "v5", minSpeechMs: 250, redemptionMs: 550,
        baseAssetPath: "/vad/", onnxWASMBasePath: "/onnx/",
        onSpeechRealStart: () => { if (modeRef.current === "speaking" || modeRef.current === "thinking") stop("voice"); setStatus("listening"); },
        onSpeechEnd: (audio: Float32Array) => { void onSpeechEnd(audio); },
      });
      await instance.start(); vad.current = instance;
      setMicLive(true); setStatus("listening");
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      if (/denied|notallowed|permission/i.test(err.name + " " + err.message)) {
        setError("Microphone permission denied. Use the lock icon in the browser address bar to allow this site's microphone.");
        return;
      }
      if (startBrowserRecognition()) setError("Voice activity detection could not start. Using browser recognition; speak your question. Configure GROQ_API_KEY for reliable transcription.");
      else setError(`Microphone setup failed: ${err.message}. Try Chrome or Edge, or type your question.`);
    }
  }

  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.matches("input,textarea")) return;
      if (e.key === "Escape") stop("button");
      if (e.key === "ArrowRight") navigate(slideRef.current + 1, "click");
      if (e.key === "ArrowLeft") navigate(slideRef.current - 1, "click");
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  });

  const current = deck.slides[slide];
  const status = { idle: "Ready", listening: "Listening", thinking: "Thinking", speaking: autoPresent ? "Presenting" : "Answering" }[mode];
  return (
    <main className="mx-auto grid max-w-[1400px] gap-4 px-4 py-4 sm:px-6 lg:grid-cols-[minmax(0,1fr)_370px]">
      <section className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <button onClick={() => { stop("navigation"); onExit(); }} className="btn h-9 px-2.5" aria-label="All decks"><ArrowLeft size={16}/></button>
          <div className="min-w-0"><div className="truncate font-semibold text-lg">{deck.title}</div><div className="text-xs" style={{color:"var(--ink-3)"}}>Live deck-aware voice session · {session.slice(0,8)}</div></div>
          <span className="rounded-full px-3 py-1 text-xs font-semibold" style={{ background: "var(--agent-soft)", color: "var(--agent)" }}>{status}</span>
          <div className="ml-auto flex gap-2">
            {resume !== null && !autoPresent && <button className="btn" onClick={() => void present(resume)}><Play size={15}/> Resume slide {resume+1}</button>}
            {!autoPresent && <button className="btn btn-primary" onClick={() => void present(slide)}><Play size={15}/> Present from here</button>}
            {autoPresent && <button className="btn btn-user" onClick={() => stop("button")}><Hand size={15}/> Stop presentation</button>}
          </div>
        </div>
        <div className="panel relative overflow-hidden">
          <div className="aspect-[16/9] min-h-[290px]">
            {current.image ? (
              <img key={slide} className="slide-enter h-full w-full object-contain" src={current.image}
                alt={`Slide ${slide + 1} of ${deck.slides.length}: ${current.title}`}/>
            ) : (
              <div key={slide} className="slide-enter flex h-full flex-col px-[6%] py-[5%]">
                <span className="num text-sm" style={{color:"var(--ink-3)"}}>{slide+1} / {deck.slides.length}</span>
                <h2 className="mt-3 font-semibold" style={{fontSize:"clamp(26px,3.8vw,46px)",lineHeight:1.1}}>{current.title}</h2>
                <ul className="mt-7 grid gap-3">{current.bullets.map((b,i) => <li key={i} className="text-lg" style={{color:highlight===i?"var(--agent)":"var(--ink-2)"}}>{b}</li>)}</ul>
              </div>
            )}
          </div>
          {toast && <div className="toast-in absolute right-4 top-4 rounded-xl px-3 py-2 text-sm" style={{background:"var(--ink)",color:"var(--surface)"}}><Zap size={14} className="mr-2 inline"/>{toast}</div>}
        </div>
        {highlight !== null && <div className="rounded-lg border px-3 py-2 text-sm" style={{background:"var(--agent-soft)",borderColor:"var(--line)",color:"var(--ink)"}}>
          <span className="font-semibold">Relevant detail:</span> {current.bullets[highlight] ?? current.title}
        </div>}
        <div className="flex flex-wrap gap-2">
          {deck.slides.map((s,i) => <button key={i} onClick={() => navigate(i,"click")} className="rounded-lg px-3 py-2 text-left text-xs" aria-current={slide===i} style={{background:"var(--surface)",border:slide===i ? "2px solid var(--agent)" : "1px solid var(--line)"}}><span className="num mr-2">{i+1}</span>{s.title.slice(0,24)}</button>)}
        </div>
        <div className="panel flex flex-wrap items-center gap-3 p-3">
          <button onClick={() => void toggleMic()} aria-label={micLive ? "Turn microphone off" : "Enable microphone"} aria-pressed={micLive} className="grid h-12 w-12 place-items-center rounded-full" style={{background:micLive ? "var(--user)":"var(--user-soft)",color:micLive ? "white":"var(--user)"}}><Mic size={20}/></button>
          <div className="flex-1 min-w-[140px] text-sm" style={{color:"var(--ink-2)"}}>{caption || (micLive ? "Microphone active · speak to interrupt or ask" : "Enable mic for hands-free questions, or type below")}</div>
          <button className="btn btn-user" onClick={() => stop("button")} disabled={mode !== "speaking" && mode !== "thinking"}><Hand size={15}/> Interrupt</button>
          <button className="btn" onClick={() => { const next = !voiceOnRef.current; voiceOnRef.current = next; setVoiceOn(next); if (!next) speaker.current.cancel(); }} aria-label={voiceOn ? "Mute" : "Unmute"}>{voiceOn ? <Volume2 size={16}/> : <VolumeX size={16}/>}</button>
        </div>
        {piiAlert.length > 0 && <div role="status" className="flex items-center gap-2 text-sm" style={{color:"var(--ok)"}}><ShieldCheck size={17}/> Redacted before the LLM: {piiAlert.join(", ")}</div>}
        {error && <p role="alert" className="text-sm" style={{color:"var(--user)"}}>{error}</p>}
        <div className="flex gap-2">
          <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e=> {if(e.key === "Enter") {askRef.current(input); setInput("");}}} placeholder="Ask about a slide..." className="h-11 min-w-0 flex-1 rounded-xl px-4" style={{background:"var(--surface)",border:"1px solid var(--line)"}}/>
          <button className="btn" onClick={() => {askRef.current(input);setInput("");}}><CornerDownLeft size={15}/> Ask</button>
        </div>
        <div className="flex flex-wrap gap-2">{deck.suggestions.map(q => <button key={q} className="chip" onClick={()=>askRef.current(q)}>{q}</button>)}</div>
      </section>
      <aside className="flex min-w-0 flex-col gap-3 lg:sticky lg:top-[72px] lg:h-[calc(100vh-88px)]">
        <div className="panel flex min-h-[320px] flex-1 flex-col overflow-hidden">
          <div className="border-b p-4 font-medium" style={{borderColor:"var(--line)"}}>Conversation · {entries.length} entries</div>
          <div className="scroll-thin flex-1 space-y-4 overflow-y-auto p-4" ref={transcriptBox}>
            {!entries.length && <p className="text-sm" style={{color:"var(--ink-3)"}}>Live narration, questions and answers appear here.</p>}
            {entries.map(e => <div key={e.id} className="text-sm"><div className="mb-1 text-xs font-medium" style={{color:e.role==="agent" ? "var(--agent)":e.role==="user" ? "var(--user)":"var(--ink-3)"}}>{e.role==="agent" ? (e.kind === "narration" ? "Presenter · narration" : "Presenter") : e.role === "user" ? "You" : "System"}</div><p>{e.text || "…"} {e.interrupted && <em className="text-xs">(interrupted)</em>}</p>{e.pii && e.pii.length>0 && <div className="text-xs" style={{color:"var(--ok)"}}>PII masked: {e.pii.join(", ")}</div>}{e.meta && <div className="mono mt-1 text-xs" style={{color:"var(--ink-3)"}}>{e.meta}</div>}</div>)}
          </div>
        </div>
        <div className="panel p-4"><div className="font-medium">Session usage</div><div className="mt-3 grid grid-cols-2 gap-3"><Stat label="Input tokens" value={totals.inTokens.toLocaleString()}/><Stat label="Output tokens" value={totals.outTokens.toLocaleString()}/><Stat label="STT seconds" value={totals.sttSeconds.toFixed(1)}/><Stat label="TTS characters" value={totals.ttsChars.toLocaleString()}/></div><p className="mt-3 text-xs" style={{color:"var(--ink-3)"}}>{totals.answers} answers · {totals.local} local commands. Usage uses provider-reported tokens when available; no cost is assumed.</p></div>
      </aside>
    </main>
  );
}

function Stat({ label, value }: { label:string; value:string }) {
  return <div><div className="text-xs" style={{color:"var(--ink-3)"}}>{label}</div><div className="num font-semibold text-xl">{value}</div></div>;
}
