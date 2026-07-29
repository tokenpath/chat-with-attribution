const DATABASE_NAME = "tokenpath-page-chats";
const DATABASE_VERSION = 1;
const STORE_NAME = "conversations";

export interface PageChatRecord<T> {
  key: string;
  savedAt: number;
  value: T;
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onerror = () =>
      reject(request.error || new Error("Couldn't open the page-chat cache."));
    request.onupgradeneeded = () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
  });
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>
) {
  const database = await openDatabase();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = run(transaction.objectStore(STORE_NAME));
      request.onerror = () =>
        reject(request.error || new Error("Page-chat cache request failed."));
      request.onsuccess = () => resolve(request.result);
      transaction.onabort = () =>
        reject(
          transaction.error || new Error("Page-chat cache transaction failed.")
        );
    });
  } finally {
    database.close();
  }
}

export function pageChatKey(pageUrl: string | null | undefined) {
  if (!pageUrl || pageUrl.length > 16_384) return null;
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    for (const key of [...url.searchParams.keys()]) {
      if (
        key.toLowerCase().startsWith("utm_") ||
        ["fbclid", "gclid", "mc_cid", "mc_eid"].includes(key.toLowerCase())
      ) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();

    if (/\.pdf$/i.test(url.pathname)) {
      url.hash = "";
    } else if (url.hash.includes(":~:text=")) {
      url.hash = url.hash.split(":~:text=", 1)[0].replace(/#$/, "");
    }
    return url.href;
  } catch {
    return null;
  }
}

export async function readPageChat<T>(key: string) {
  const record = await withStore<PageChatRecord<T> | undefined>(
    "readonly",
    (store) => store.get(key)
  );
  return record || null;
}

export async function writePageChat<T>(key: string, value: T) {
  await withStore<IDBValidKey>("readwrite", (store) =>
    store.put({ key, savedAt: Date.now(), value })
  );
}

export async function deletePageChat(key: string) {
  await withStore<undefined>("readwrite", (store) => store.delete(key));
}

function normalizedWords(text: string) {
  return String(text || "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function sampledShingles(text: string) {
  const words = normalizedWords(text);
  if (words.length < 5) return new Set([words.join(" ")]);
  const stride = Math.max(1, Math.floor((words.length - 4) / 1_200));
  const shingles = new Set<string>();
  for (let index = 0; index <= words.length - 5; index += stride) {
    shingles.add(words.slice(index, index + 5).join(" "));
  }
  shingles.add(words.slice(-5).join(" "));
  return shingles;
}

export function pageContentSimilarity(previous: string, current: string) {
  const left = sampledShingles(previous);
  const right = sampledShingles(current);
  if (left.size === 0 && right.size === 0) return 1;
  if (left.size === 0 || right.size === 0) return 0;
  let overlap = 0;
  for (const shingle of left) {
    if (right.has(shingle)) overlap++;
  }
  return overlap / Math.min(left.size, right.size);
}

export function pageContentSignificantlyChanged(
  previous: string,
  current: string
) {
  const oldWords = normalizedWords(previous);
  const newWords = normalizedWords(current);
  if (oldWords.length < 20 || newWords.length < 20) {
    return oldWords.join(" ") !== newWords.join(" ");
  }
  const lengthRatio =
    Math.min(oldWords.length, newWords.length) /
    Math.max(oldWords.length, newWords.length);
  return lengthRatio < 0.55 || pageContentSimilarity(previous, current) < 0.72;
}
