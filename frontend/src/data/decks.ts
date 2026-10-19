export type Slide = {
  title: string;
  bullets: string[];
  notes: string;
  narration: string;
  keywords: string[];
  image?: string;
};
export type Deck = {
  id: string;
  title: string;
  blurb: string;
  suggestions: string[];
  slides: Slide[];
};
export type DeckPreview = Pick<Deck, "id" | "title" | "blurb"> & { slideCount: number; cover: string };
export const DECKS: DeckPreview[] = [
  {"id": "business-report-example", "title": "Q4 2024 Business Review", "blurb": "Executive review of quarterly achievements, revenue, market share, regional results and next-quarter priorities.", "slideCount": 7, "cover": "/slides/business-report-example/1.webp"},
  {"id": "ai-value-realization-demo", "title": "AI Value Realization", "blurb": "Consulting demonstration on where AI value concentrates and how to scale high-value workflows.", "slideCount": 6, "cover": "/slides/ai-value-realization-demo/1.webp"},
  {"id": "retail-banking-growth-demo", "title": "Retail Banking Growth", "blurb": "Consulting demonstration covering primary relationships, customer economics, journey leakage and growth priorities.", "slideCount": 6, "cover": "/slides/retail-banking-growth-demo/1.webp"}
];
