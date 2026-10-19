import { DECKS, type Deck } from "@/data/decks";
import { getDeck, parseDeck } from "@/lib/api";
import { useRef, useState } from "react";
import { Mic, Hand, MoveRight } from "lucide-react";

export function Home({ onPick }: { onPick: (d: Deck) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const uploader = useRef<HTMLInputElement>(null);
  const openPreset = async (id: string) => {
    setBusy(true); setError("");
    try { onPick(await getDeck(id)); } catch(e) { setError(e instanceof Error ? e.message : "Could not load the deck"); }
    finally { setBusy(false); }
  };
  const onUpload = async (file?: File) => {
    if (!file) return;
    setBusy(true); setError("");
    try { onPick(await parseDeck(file)); } catch(e) { setError(e instanceof Error ? e.message : "Could not parse PPTX"); }
    finally { setBusy(false); }
  };
  return (
    <main className="mx-auto max-w-[1100px] px-4 pb-20 pt-12 sm:px-6 sm:pt-16">
      <div className="grid gap-10 md:grid-cols-[1.1fr_1fr] md:items-end">
        <div>
          <h1 className="font-semibold tracking-tight" style={{ fontSize: "clamp(34px, 5vw, 54px)", lineHeight: 1.04, letterSpacing: "-0.02em" }}>
            Pick a deck.<br />Ask it anything.
          </h1>
          <p className="mt-5 max-w-[46ch]" style={{ color: "var(--ink-2)", fontSize: 17 }}>
            An AI presenter talks you through six slides. Ask a question and it jumps to the slide that answers it. Start speaking and it stops to listen.
          </p>
        </div>
        <ul className="grid gap-3 text-sm" style={{ color: "var(--ink-2)" }}>
          <Step icon={<Mic size={16} />} color="var(--user)" title="You ask out loud" text="Speech is transcribed and checked for personal information." />
          <Step icon={<MoveRight size={16} />} color="var(--agent)" title="It finds the right slide" text="A router picks the slide before the answer starts." />
          <Step icon={<Hand size={16} />} color="var(--ink)" title="You can cut in anytime" text="Playback stops the moment you start talking." />
        </ul>
      </div>

      <h2 className="mt-14 mb-4 text-sm font-medium" style={{ color: "var(--ink-3)" }}>Preset decks</h2>
      <div className="grid gap-4 md:grid-cols-3">
        {DECKS.map((d) => (
          <button key={d.id} onClick={() => void openPreset(d.id)} disabled={busy} className="panel group flex flex-col overflow-hidden text-left transition-colors hover:border-[var(--ink-3)]">
            <MiniSlide deck={d} />
            <div className="flex flex-1 flex-col p-4">
              <div className="font-semibold" style={{ fontSize: 17 }}>{d.title}</div>
              <p className="mt-1 flex-1 text-sm" style={{ color: "var(--ink-2)" }}>{d.blurb}</p>
              <div className="mt-4 flex items-center justify-between text-sm">
                <span style={{ color: "var(--ink-3)" }}>{d.slides.length} slides</span>
                <span className="font-medium group-hover:underline">Start presenting</span>
              </div>
            </div>
          </button>
        ))}
      </div>
      <div className="mt-6 flex items-center gap-3">
        <input ref={uploader} type="file" accept=".pptx,application/vnd.openxmlformats-officedocument.presentationml.presentation" className="hidden" onChange={(e) => void onUpload(e.target.files?.[0])} />
        <button className="btn btn-primary" disabled={busy} onClick={() => uploader.current?.click()}>{busy ? "Loading…" : "Upload PPTX"}</button>
        {error && <span className="text-sm" style={{color:"var(--user)"}} role="alert">{error}. Check the backend URL and API keys.</span>}
      </div>
      <p className="mt-6 text-sm" style={{ color: "var(--ink-3)" }}>
        Have your own slides? Upload any standard PPTX for live parsing into a new presentation.
      </p>
    </main>
  );
}

function Step({ icon, color, title, text }: { icon: React.ReactNode; color: string; title: string; text: string }) {
  return (
    <li className="flex gap-3">
      <span className="mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg" style={{ background: "var(--surface)", border: "1px solid var(--line)", color }}>{icon}</span>
      <span><span className="font-medium" style={{ color: "var(--ink)" }}>{title}.</span> {text}</span>
    </li>
  );
}

function MiniSlide({ deck }: { deck: Deck }) {
  const s = deck.slides[0];
  return (
    <div className="aspect-[16/9] border-b p-4" style={{ background: "var(--surface-2)", borderColor: "var(--line)" }}>
      <div className="h-full rounded-lg p-3" style={{ background: "var(--surface)", border: "1px solid var(--line)" }}>
        <div className="font-semibold" style={{ fontSize: 13 }}>{s.title}</div>
        <div className="mt-2 grid gap-1.5">
          {s.bullets.map((b, i) => (
            <div key={i} className="flex items-center gap-1.5">
              <span className="h-1 w-1 rounded-full" style={{ background: "var(--ink-3)" }} />
              <span className="h-1.5 rounded-full" style={{ background: "var(--line)", width: `${60 + ((b.length * 7) % 35)}%` }} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

