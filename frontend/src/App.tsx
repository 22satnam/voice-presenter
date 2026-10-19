import { useState } from "react";
import { Navbar } from "@/views/Navbar";
import { Home } from "@/views/Home";
import { Presenter } from "@/views/Presenter";
import type { Deck } from "@/data/decks";

export default function App() {
  const [deck, setDeck] = useState<Deck | null>(null);
  return (
    <div className="min-h-full">
      <Navbar view={deck ? "present" : "home"} onNav={(v) => { if (v === "home") setDeck(null); }} />
      {deck ? <Presenter key={`${deck.id}:${deck.title}`} deck={deck} onExit={() => setDeck(null)} /> : <Home onPick={setDeck} />}
    </div>
  );
}
