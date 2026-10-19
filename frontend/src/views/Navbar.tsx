import { FolderGit2, BriefcaseBusiness, Globe, Presentation, TerminalSquare } from "lucide-react";

export type View = "home" | "present" | "console";

const LINKS = [
  { label: "GitHub", href: "https://github.com/22satnam/voice-presenter", icon: FolderGit2 },
  { label: "Portfolio", href: "https://satnamsingh.in", icon: Globe },
  { label: "LinkedIn", href: "https://linkedin.com/in/22satnam", icon: BriefcaseBusiness },
];

export function Navbar({ view, onNav }: { view: View; onNav: (v: View) => void }) {
    const consoleUrl = import.meta.env.VITE_CONSOLE_URL || import.meta.env.VITE_API_BASE || "http://localhost:8000";
  return (
    <header className="sticky top-0 z-30 border-b" style={{ borderColor: "var(--line)", background: "var(--surface)" }}>
      <div className="mx-auto flex h-14 max-w-[1400px] items-center gap-4 px-4 sm:px-6">
        <button onClick={() => onNav("home")} className="flex items-center gap-2 font-semibold" style={{ fontSize: 17 }}>
          <Logo />
          Podium
        </button>

        <nav aria-label="App" className="ml-2 flex rounded-xl p-1" style={{ background: "var(--surface-2)", border: "1px solid var(--line)" }}>
          <Seg active={true} onClick={() => onNav(view === "console" ? "home" : view)} icon={<Presentation size={15} />} label="Presenter" />
          <a href={consoleUrl} target="_blank" rel="noreferrer" className="flex items-center gap-1.5 rounded-lg px-3 py-1 text-sm" style={{color:"var(--ink-3)"}}><TerminalSquare size={15} /><span className="hidden sm:inline">Backend console</span></a>
        </nav>

        <div className="ml-auto flex items-center gap-1">
          {LINKS.map(({ label, href, icon: Icon }) => (
            <a key={label} href={href} target="_blank" rel="noreferrer"
               className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-sm hover:bg-[var(--surface-2)]"
               style={{ color: "var(--ink-2)" }}>
              <Icon size={15} aria-hidden />
              <span className="hidden md:inline">{label}</span>
            </a>
          ))}
        </div>
      </div>
    </header>
  );
}

function Seg({ active, onClick, icon, label }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string }) {
  return (
    <button onClick={onClick} aria-current={active ? "page" : undefined}
      className="flex items-center gap-1.5 rounded-lg px-3 py-1 text-sm transition-colors"
      style={{
        background: active ? "var(--surface)" : "transparent",
        color: active ? "var(--ink)" : "var(--ink-3)",
        boxShadow: active ? "0 0 0 1px var(--line)" : "none",
        fontWeight: active ? 500 : 400,
      }}>
      {icon}<span className="hidden sm:inline">{label}</span>
    </button>
  );
}

function Logo() {
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
      <rect x="1" y="1" width="20" height="20" rx="6" fill="var(--ink)" />
      <rect x="6" y="9" width="2" height="5" rx="1" fill="var(--agent-soft)" />
      <rect x="10" y="6" width="2" height="11" rx="1" fill="var(--surface)" />
      <rect x="14" y="8" width="2" height="7" rx="1" fill="var(--user-soft)" />
    </svg>
  );
}

