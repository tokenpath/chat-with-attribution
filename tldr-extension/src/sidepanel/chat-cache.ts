const DATABASE_NAME = "tokenpath-page-chats";
// Version 2 stores each captured document once per record instead of once per
// message, and adds the savedAt index that bounded retention walks.
const DATABASE_VERSION = 2;
const STORE_NAME = "conversations";
const SAVED_AT_INDEX = "savedAt";
const MAX_CACHED_PAGE_CHATS = 50;
const MAX_PAGE_CHAT_AGE_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_URL_CHARS = 16_384;
const TRACKING_PARAMETERS = ["fbclid", "gclid", "mc_cid", "mc_eid"];
// Host-scoped identity rule. A YouTube watch page IS its video, so `?v=` stays
// part of the key like any other query parameter. Its time parameters are not:
// a share link ("…&t=612"), a chapter link, and the plain watch URL are one
// document at three playback positions, exactly like a "#section" anchor.
// Stripping these globally would be wrong — `t` is a meaningful query
// parameter elsewhere — so the rule is scoped to YouTube's hosts.
const YOUTUBE_TIME_PARAMETERS = ["t", "start", "time_continue"];

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
      // The cache is disposable: dropping an earlier format costs one
      // re-capture and avoids carrying a migration for every past shape.
      if (database.objectStoreNames.contains(STORE_NAME)) {
        database.deleteObjectStore(STORE_NAME);
      }
      const store = database.createObjectStore(STORE_NAME, { keyPath: "key" });
      store.createIndex(SAVED_AT_INDEX, "savedAt");
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
      let result: T | undefined;
      request.onerror = () =>
        reject(request.error || new Error("Page-chat cache request failed."));
      request.onsuccess = () => {
        result = request.result;
      };
      // Resolve on commit, not on the request: a transaction that aborts after
      // a successful request must still reject rather than report a write that
      // was rolled back.
      transaction.oncomplete = () => resolve(result as T);
      transaction.onabort = () =>
        reject(
          transaction.error || new Error("Page-chat cache transaction failed.")
        );
    });
  } finally {
    database.close();
  }
}

// Plain "#section" anchors, Chrome's ":~:text=" highlight directives, and the
// native PDF viewer's #page/#zoom parameters all move the viewport inside one
// document, so none of them belongs to a page's identity. Gmail and
// conventional hash-routed SPAs ("#!…", "#/…") instead use the hash AS the
// route — stripping those would key one chat across every email or view.
// content.js's currentRouteKey applies the identical rule; the two must agree
// or a chat restores against one document while highlights resolve against
// another.
function identityHash(url: URL) {
  if (url.hostname === "mail.google.com" || /^#(?:!|\/)/.test(url.hash)) {
    return url.hash;
  }
  return "";
}

function isYouTubeHost(hostname: string) {
  return /^(?:(?:www|m|music)\.)?youtube\.com$/i.test(hostname) ||
    /^(?:www\.)?youtu\.be$/i.test(hostname);
}

// Drop only the parameters that move the playhead inside one video.
// content.js's currentRouteKey applies the identical rule; the two must agree
// or a chat restores against one document while attribution seeks in another.
function stripHostScopedParameters(url: URL) {
  if (!isYouTubeHost(url.hostname)) return;
  for (const parameter of YOUTUBE_TIME_PARAMETERS) {
    url.searchParams.delete(parameter);
  }
}

export function documentIdentityUrl(pageUrl: string | null | undefined) {
  if (!pageUrl || pageUrl.length > MAX_URL_CHARS) return null;
  try {
    const url = new URL(pageUrl);
    url.hash = identityHash(url);
    stripHostScopedParameters(url);
    return url.href;
  } catch {
    return pageUrl.split("#", 1)[0] || null;
  }
}

export function sameDocumentUrl(
  candidateUrl: string | null | undefined,
  sourceUrl: string | null | undefined
) {
  const candidate = documentIdentityUrl(candidateUrl);
  const source = documentIdentityUrl(sourceUrl);
  return candidate != null && candidate === source;
}

export function pageChatKey(pageUrl: string | null | undefined) {
  if (!pageUrl || pageUrl.length > MAX_URL_CHARS) return null;
  try {
    const url = new URL(pageUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;

    for (const key of [...url.searchParams.keys()]) {
      if (
        key.toLowerCase().startsWith("utm_") ||
        TRACKING_PARAMETERS.includes(key.toLowerCase())
      ) {
        url.searchParams.delete(key);
      }
    }
    stripHostScopedParameters(url);
    url.searchParams.sort();
    url.hash = identityHash(url);
    return url.href;
  } catch {
    return null;
  }
}

// Retention is a housekeeping pass, not a per-request cost: one bounded walk
// of the savedAt index per panel session keeps the cache from growing without
// limit while a read or write is already touching the database.
let retention: Promise<void> | null = null;

function enforceRetention() {
  retention ||= pruneStoredPageChats().catch(() => undefined);
  return retention;
}

async function pruneStoredPageChats() {
  const database = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, "readwrite");
      const store = transaction.objectStore(STORE_NAME);
      const expiredBefore = Date.now() - MAX_PAGE_CHAT_AGE_MS;
      const entries: Array<{ key: IDBValidKey; savedAt: number }> = [];
      // A key cursor keeps the multi-hundred-kilobyte values out of memory.
      const cursorRequest = store.index(SAVED_AT_INDEX).openKeyCursor();
      cursorRequest.onerror = () =>
        reject(
          cursorRequest.error || new Error("Page-chat cache request failed.")
        );
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (cursor) {
          entries.push({
            key: cursor.primaryKey,
            savedAt: Number(cursor.key) || 0,
          });
          cursor.continue();
          return;
        }
        // The index walks savedAt ascending, so the surplus is the prefix:
        // least recently updated page-chats go first.
        const surplus = Math.max(0, entries.length - MAX_CACHED_PAGE_CHATS);
        entries.forEach((entry, index) => {
          if (index < surplus || entry.savedAt < expiredBefore) {
            store.delete(entry.key);
          }
        });
      };
      transaction.oncomplete = () => resolve();
      transaction.onabort = () =>
        reject(
          transaction.error || new Error("Page-chat cache transaction failed.")
        );
    });
  } finally {
    database.close();
  }
}

export async function readPageChat<T>(key: string) {
  const record = await withStore<PageChatRecord<T> | undefined>(
    "readonly",
    (store) => store.get(key)
  );
  void enforceRetention();
  return record || null;
}

export async function writePageChat<T>(key: string, value: T) {
  await withStore<IDBValidKey>("readwrite", (store) =>
    store.put({ key, savedAt: Date.now(), value })
  );
  void enforceRetention();
}

export async function deletePageChat(key: string) {
  await withStore<undefined>("readwrite", (store) => store.delete(key));
}

export async function clearAll() {
  await withStore<undefined>("readwrite", (store) => store.clear());
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
