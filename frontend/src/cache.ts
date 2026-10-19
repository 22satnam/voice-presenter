export type CachedSlide = {
  text: string;
  sentences: string[];
  audio: ArrayBuffer;
};

export type CachedDeck = {
  cacheVersion: string;
  deckId: string;
  slides: CachedSlide[];
  fillers: {
    goodQuestion: ArrayBuffer;
    letMeShowYou: ArrayBuffer;
    anyQuestions: ArrayBuffer;
    finalQuestions: ArrayBuffer;
  };
};

const DB_NAME = 'voice-presenter';
const STORE = 'prepared-decks';

// v2 stores one audio file per slide instead of one request per sentence.
export const CACHE_VERSION = '2026-10-20-v2';

function openDb() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open presentation cache'));
  });
}

export async function readPreparedDeck(deckId: string): Promise<CachedDeck | null> {
  const db = await openDb();
  try {
    return await new Promise<CachedDeck | null>((resolve, reject) => {
      const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(deckId);
      request.onsuccess = () => {
        const value = request.result as CachedDeck | undefined;
        resolve(value?.cacheVersion === CACHE_VERSION ? value : null);
      };
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export async function savePreparedDeck(deck: CachedDeck) {
  const db = await openDb();
  try {
    await new Promise<void>((resolve, reject) => {
      const request = db.transaction(STORE, 'readwrite').objectStore(STORE).put(deck, deck.deckId);
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  } finally {
    db.close();
  }
}

export function splitSentences(text: string): string[] {
  return (text.match(/[^.!?]+(?:[.!?]+|$)/g) || [text])
    .map(sentence => sentence.trim())
    .filter(Boolean);
}

export function sentenceBoundary(
  sentences: string[],
  duration: number,
  currentOffset: number,
) {
  if (!sentences.length || duration <= 0 || currentOffset <= 0) return 0;

  const weights = sentences.map(sentence => Math.max(1, sentence.length));
  const total = weights.reduce((sum, value) => sum + value, 0);
  let elapsed = 0;
  let boundary = 0;

  for (const weight of weights) {
    const next = elapsed + duration * (weight / total);
    if (next > currentOffset) return Math.max(0, boundary);
    boundary = next;
    elapsed = next;
  }

  return Math.max(0, Math.min(boundary, duration));
}
