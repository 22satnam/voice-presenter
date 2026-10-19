export type CachedSentence = {
  text: string;
  audio: ArrayBuffer;
};

export type CachedSlide = {
  text: string;
  sentences: CachedSentence[];
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
export const CACHE_VERSION = '2026-10-20-v1';

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
  const raw = text.match(/[^.!?]+(?:[.!?]+|$)/g) || [text];
  const sentences: string[] = [];

  for (const item of raw) {
    let sentence = item.trim();
    while (sentence.length > 900) {
      let cut = sentence.lastIndexOf(',', 880);
      if (cut < 350) cut = sentence.lastIndexOf(' ', 880);
      if (cut < 200) cut = 880;
      sentences.push(sentence.slice(0, cut + 1).trim());
      sentence = sentence.slice(cut + 1).trim();
    }
    if (sentence) sentences.push(sentence);
  }

  return sentences;
}
