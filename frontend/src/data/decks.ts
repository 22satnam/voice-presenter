export type Slide = {
  title: string;
  bullets: string[];
  notes: string;
  narration: string;
  keywords: string[];
};

export type Deck = {
  id: string;
  title: string;
  blurb: string;
  suggestions: string[];
  slides: Slide[];
};

// Placeholder presets. In the real build these come from
// GET /api/decks/{id}, parsed from the PPTX files with python-pptx.
export const DECKS: Deck[] = [
  {
    id: "voice-agents",
    title: "How voice AI agents work",
    blurb: "The pipeline behind an assistant that listens, thinks, and talks back.",
    suggestions: [
      "How does it know when I start talking?",
      "Why not just use one speech-to-speech model?",
      "Where does the latency come from?",
      "My number is 98765 43210, can you send me this deck?",
    ],
    slides: [
      {
        title: "Talking to software",
        bullets: ["Voice is the fastest input we have", "Agents now answer in under a second", "This deck explains the pieces"],
        notes: "Voice agents feel natural because speaking is faster than typing. Modern pipelines respond in well under a second, which is the threshold where a conversation stops feeling like a form.",
        narration: "Let's start with why voice matters. Speaking is the fastest way we have to ask for something, and today's agents can answer in under a second. Over the next few slides I'll show you how that works.",
        keywords: ["why", "voice", "intro", "start", "software"],
      },
      {
        title: "The cascaded pipeline",
        bullets: ["Speech-to-text turns audio into words", "An LLM decides what to say", "Text-to-speech speaks the answer"],
        notes: "A cascaded pipeline has three stages: speech-to-text, a language model, and text-to-speech. Each stage can be swapped, measured, and costed on its own, which is why I chose it over a single speech-to-speech model.",
        narration: "Most voice agents are built as a cascade. Speech-to-text turns your audio into words, a language model decides what to say, and text-to-speech speaks it back. Each stage can be swapped and measured on its own.",
        keywords: ["pipeline", "cascade", "stt", "tts", "speech-to-speech", "model", "architecture", "one", "single"],
      },
      {
        title: "Knowing when you speak",
        bullets: ["Voice activity detection runs in the browser", "250 ms of speech confirms a real turn", "Echo cancellation ignores the agent's voice"],
        notes: "Voice activity detection runs locally in your browser and watches the microphone. Once it hears about a quarter second of continuous speech, it treats that as a real turn, and echo cancellation stops the agent from hearing itself.",
        narration: "To have a conversation, the agent has to know when you're talking. A small voice activity model runs right in the browser, waits for about a quarter second of real speech, and ignores the agent's own voice.",
        keywords: ["vad", "voice activity", "detect", "know", "talking", "speak", "start", "listen", "echo"],
      },
      {
        title: "Interrupting the agent",
        bullets: ["Playback stops the instant you speak", "In-flight requests are cancelled", "Only words you heard stay in memory"],
        notes: "When you interrupt, playback stops immediately, every in-flight request is aborted, and the conversation history keeps only the sentences you actually heard. That way the agent never assumes it said something you missed.",
        narration: "You can cut me off at any time. The moment you speak, playback stops, pending requests are cancelled, and I only remember the words you actually heard.",
        keywords: ["interrupt", "barge", "stop", "cut", "cancel"],
      },
      {
        title: "Where latency comes from",
        bullets: ["Speech-to-text: around 300 ms", "First LLM token: around 400 ms", "First audio byte: around 250 ms"],
        notes: "Most of the delay comes from three places: transcription, the first token from the language model, and the first audio from text-to-speech. Streaming each sentence to speech as soon as it's written hides most of it.",
        narration: "Here's where the time goes. Transcription, the first token from the model, and the first audio byte each add a few hundred milliseconds. Streaming sentence by sentence hides most of it.",
        keywords: ["latency", "slow", "fast", "speed", "time", "delay", "milliseconds"],
      },
      {
        title: "Running it for free",
        bullets: ["Free tiers for speech, LLM, and hosting", "Automatic fallback when a quota runs out", "Every token is counted and shown"],
        notes: "Everything here runs on free tiers. When a provider hits its rate limit, the system falls back to another one automatically, and every token is counted so the cost is always visible.",
        narration: "Finally, cost. This whole system runs on free tiers, falls back automatically when a quota runs out, and counts every token so you can see exactly what each answer costs.",
        keywords: ["cost", "free", "price", "token", "quota", "money", "cheap"],
      },
    ],
  },
  {
    id: "rag",
    title: "Retrieval-augmented generation",
    blurb: "How language models answer from your documents instead of their memory.",
    suggestions: [
      "What problem does RAG solve?",
      "How are documents split up?",
      "How do you know if it's working?",
      "Email me at satnam@example.com with the slides",
    ],
    slides: [
      {
        title: "Models forget, documents don't",
        bullets: ["LLMs only know their training data", "Your documents change every day", "RAG connects the two"],
        notes: "Language models only know what they were trained on, and your documents change constantly. Retrieval-augmented generation fetches the relevant passages at question time so the model answers from current facts.",
        narration: "Language models only know what they saw during training, but your documents change every day. Retrieval-augmented generation bridges that gap.",
        keywords: ["problem", "why", "solve", "rag", "what", "forget"],
      },
      {
        title: "Chunking documents",
        bullets: ["Split text into passages of a few hundred tokens", "Overlap chunks so ideas aren't cut in half", "Keep titles and headings as context"],
        notes: "Documents are split into passages of a few hundred tokens, with some overlap so an idea isn't cut in half. Keeping the heading with each chunk gives the model context about where it came from.",
        narration: "First, documents are split into chunks of a few hundred tokens, with a little overlap, and each chunk keeps its heading for context.",
        keywords: ["chunk", "split", "documents", "passages", "overlap"],
      },
      {
        title: "Embeddings and search",
        bullets: ["Each chunk becomes a vector", "Questions become vectors too", "Nearest vectors are the best matches"],
        notes: "Each chunk is turned into a vector that captures its meaning. The question is embedded the same way, and the closest vectors are the passages most likely to answer it.",
        narration: "Each chunk becomes a vector that captures its meaning. Your question becomes a vector too, and the nearest ones are the best matches.",
        keywords: ["embedding", "vector", "search", "similar", "nearest"],
      },
      {
        title: "Grounded answers",
        bullets: ["Top passages go into the prompt", "The model cites where facts came from", "No match means saying so"],
        notes: "The best passages are placed in the prompt, and the model is told to answer only from them and cite its sources. If nothing relevant is found, it should say so rather than guess.",
        narration: "The best passages go into the prompt. The model answers from them, cites its sources, and admits when nothing matches.",
        keywords: ["answer", "prompt", "cite", "grounded", "hallucinate"],
      },
      {
        title: "Measuring quality",
        bullets: ["Retrieval: did we fetch the right passage?", "Faithfulness: does the answer match it?", "A small golden question set goes far"],
        notes: "You measure two things separately: whether retrieval found the right passage, and whether the answer stays faithful to it. Even fifty hand-written golden questions catch most regressions.",
        narration: "To know it's working, measure retrieval and faithfulness separately. Even a small set of golden questions catches most problems.",
        keywords: ["measure", "quality", "evaluate", "working", "test", "metrics"],
      },
      {
        title: "Going to production",
        bullets: ["Re-index when documents change", "Filter by permissions before retrieval", "Log every question and source"],
        notes: "In production you re-index whenever documents change, filter results by the user's permissions before retrieval, and log each question with its sources so you can debug bad answers.",
        narration: "In production, keep the index fresh, respect permissions before retrieval, and log every question with its sources.",
        keywords: ["production", "deploy", "permissions", "scale", "log"],
      },
    ],
  },
  {
    id: "smart-home",
    title: "Designing a smart home",
    blurb: "Planning wiring, sensors, and automation before the walls go up.",
    suggestions: [
      "What should I plan before construction?",
      "Which sensors are worth adding?",
      "Should I add a voice assistant?",
      "Next slide",
    ],
    slides: [
      {
        title: "Plan before the slab",
        bullets: ["Conduits are cheap now, expensive later", "Run extra pipes to every room", "Mark switchboard heights early"],
        notes: "The cheapest time to plan automation is before construction. Empty conduits cost very little during the slab and walls stage, and running a spare pipe to every room saves breaking walls later.",
        narration: "The best time to plan a smart home is before the slab is poured. Conduits are cheap now and very expensive later.",
        keywords: ["plan", "before", "construction", "conduit", "slab", "wiring"],
      },
      {
        title: "Lighting without false ceilings",
        bullets: ["Surface-mounted profiles and wall washers", "Group circuits by scene, not by room", "Dimmable drivers from day one"],
        notes: "Without a false ceiling, lighting comes from surface profiles and wall washers. Grouping circuits by scene rather than room, and choosing dimmable drivers upfront, makes automation simple later.",
        narration: "Without a false ceiling, you lean on surface profiles and wall washers, and group circuits by scene rather than by room.",
        keywords: ["lighting", "light", "ceiling", "dimmer", "scene"],
      },
      {
        title: "Sensors that earn their place",
        bullets: ["Motion in corridors and bathrooms", "Door contacts on main entries", "Water leak sensors under sinks"],
        notes: "Not every sensor is worth it. Motion sensors in corridors and bathrooms, contacts on main doors, and leak sensors under sinks give the most value for the least effort.",
        narration: "Only a few sensors really earn their place: motion in corridors and bathrooms, contacts on the main doors, and leak sensors under sinks.",
        keywords: ["sensor", "motion", "door", "leak", "worth"],
      },
      {
        title: "The control layer",
        bullets: ["A local hub keeps working offline", "Phone app for everyday control", "Physical switches always still work"],
        notes: "A local hub keeps everything running when the internet drops. The phone app handles everyday control, but physical switches should always work too, so guests are never stuck.",
        narration: "A local hub keeps things working offline. The phone app handles daily control, but the physical switches must always work.",
        keywords: ["control", "hub", "app", "phone", "offline", "switch"],
      },
      {
        title: "Voice, later",
        bullets: ["Start with app and sensors", "Add voice once routines are stable", "Keep wake words off in bedrooms"],
        notes: "Voice is best added last, once routines are stable and you know what you actually ask for. Starting with the app and sensors avoids building voice commands nobody uses.",
        narration: "Voice comes last. Get the app and sensors right first, then add voice once you know which routines you actually use.",
        keywords: ["voice", "assistant", "alexa", "jarvis", "speak"],
      },
      {
        title: "A phased budget",
        bullets: ["Phase 1: conduits and boxes", "Phase 2: lighting and switches", "Phase 3: sensors and automation"],
        notes: "Splitting the budget into phases keeps it manageable: conduits and boxes during construction, lighting and switches at finishing, and sensors and automation once you've lived in the house.",
        narration: "Finally, budget in three phases: conduits during construction, lighting at finishing, and automation once you've moved in.",
        keywords: ["budget", "cost", "phase", "money", "price"],
      },
    ],
  },
];

