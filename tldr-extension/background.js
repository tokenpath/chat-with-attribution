// TokenPath — background service worker (MV3).
// Responsibilities:
//  - create one TokenPath chat action for selections and page/frame clicks
//  - on click: open the side panel in the click's user-gesture context, then
//    capture from the page content script, Chrome's native PDF selection, or
//    ask the side panel to read an entire searchable PDF.
//  - stash the extracted text (keyed by tabId) in session storage and notify
//    an already-open panel.
//  - translate PDF source ranges into native text-fragment navigation.

const MENU_ID = "tokenpath-chat";
const MENU_CONTEXTS = ["selection", "page", "frame"];
const LEGACY_MENU_IDS = [
  "tldr-capture",
  "TokenPath",
  "tokenpath-tldr",
  "tokenpath-simplify",
  "tokenpath-ask",
];
const LEGACY_MENU_INTENTS = new Map([
  ["tokenpath-tldr", "tldr"],
  ["tokenpath-simplify", "simplify"],
  ["tokenpath-ask", "ask"],
]);
const CHROME_PDF_VIEWER_ORIGIN =
  "chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/";
const PDF_SOURCE_TYPE = "chrome-pdf";
const PDF_FRAGMENT_CONTEXT_CHARS = 64;
const PDF_FRAGMENT_EDGE_CHARS = 96;
const PDF_FRAGMENT_FULL_TARGET_CHARS = 240;
const PDF_URL_COMMIT_TIMEOUT_MS = 5000;
// The last PDF URL this worker applied to a tab, per tab. It lives in
// chrome.storage.session rather than a Map because MV3 suspends this worker
// after ~30 seconds of idle: an in-memory record is almost always gone by the
// time the user clicks the next attribution, and its loss makes an unchanged
// fragment reload the PDF all over again.
const PDF_APPLIED_URL_PREFIX = "pdfApplied:";
let captureSequence = 0;
let contextMenuEnsurePromise = null;
let legacyMenuMigrationPromise = null;
const latestCaptureByTab = new Map();
const latestPdfOperationByTab = new Map();

function runContextMenuOperation(method, args) {
  return new Promise((resolve) => {
    try {
      chrome.contextMenus[method](...args, () => {
        const operationError = chrome.runtime.lastError;
        resolve(!operationError);
      });
    } catch {
      resolve(false);
    }
  });
}

async function upsertContextMenuItem(id, properties) {
  const updated = await runContextMenuOperation("update", [id, properties]);
  if (updated) return;
  await runContextMenuOperation("create", [{ id, ...properties }]);
}

function migrateLegacyContextMenu() {
  if (!legacyMenuMigrationPromise) {
    legacyMenuMigrationPromise = Promise.all(
      LEGACY_MENU_IDS.map((id) =>
        runContextMenuOperation("remove", [id])
      )
    ).then(() => undefined);
  }
  return legacyMenuMigrationPromise;
}

function ensureContextMenus() {
  if (contextMenuEnsurePromise) return contextMenuEnsurePromise;

  contextMenuEnsurePromise = (async () => {
    await migrateLegacyContextMenu();
    await upsertContextMenuItem(MENU_ID, {
      title: "Chat with TokenPath",
      contexts: MENU_CONTEXTS,
    });
  })().finally(() => {
    contextMenuEnsurePromise = null;
  });

  return contextMenuEnsurePromise;
}

chrome.runtime.onInstalled.addListener(() => {
  void ensureContextMenus();
});
// Unpacked-extension reloads do not consistently emit onInstalled. Upserting on
// service-worker startup also migrates the legacy standalone TLDR item.
void ensureContextMenus();

// The toolbar icon is the one-click TLDR entry point: capture the complete
// active page (or PDF), open the panel, and start the automatic summary.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: false })
  .catch(() => {});

chrome.action.onClicked.addListener((tab) => {
  if (!tab || tab.id == null) return;
  return captureAndOpen(
    "tldr",
    { frameId: 0, forceFullPage: true },
    tab
  );
});

// A closed tab can never be navigated again, and its id will be reused. Drop
// the per-tab PDF bookkeeping with it so a recycled id cannot inherit a stale
// "already applied" URL.
chrome.tabs.onRemoved.addListener((tabId) => {
  latestCaptureByTab.delete(tabId);
  latestPdfOperationByTab.delete(tabId);
  void forgetAppliedPdfUrl(tabId);
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const intent =
    info.menuItemId === MENU_ID
      ? "ask"
      : LEGACY_MENU_INTENTS.get(String(info.menuItemId));
  if (!intent || !tab || tab.id == null) return;
  return captureAndOpen(intent, info, tab);
});

async function captureAndOpen(intent, info, tab, openPanel = true) {
  if (!tab || tab.id == null) return;
  const tabId = tab.id;
  const frameId = Number.isInteger(info.frameId) ? info.frameId : 0;
  const hasLegacyPdfFrame = isChromePdfViewerFrame(info.frameUrl);
  const pdfDetection = detectTopLevelChromePdf(tabId);
  // Freshness is click order, not extraction completion order. Dynamic pages
  // can make an older capture resolve after a newer click.
  const capturedAt = Date.now();
  const captureId = `${capturedAt}:${++captureSequence}`;
  latestCaptureByTab.set(tabId, captureId);

  // Also start an idempotent injection immediately, before the panel can take
  // focus. Declared content scripts are not retroactively added to tabs that
  // were already open when an unpacked extension was reloaded. Starting this
  // without awaiting preserves the user gesture for sidePanel.open while giving
  // content.js a chance to snapshot the still-live selection.
  const contentReady = hasLegacyPdfFrame
    ? Promise.resolve()
    : warmContentScript(tabId, frameId);

  // MUST be called synchronously within the user-gesture of the click,
  // otherwise chrome.sidePanel.open throws. Do not await it before capture:
  // opening the panel can take seconds and dynamic pages (notably Gmail) may
  // replace the selected DOM nodes in that time.
  if (openPanel) {
    chrome.sidePanel.open({ tabId }).catch((e) => {
      console.error("[TokenPath] sidePanel.open failed:", e);
    });
  }

  const isChromePdf = await pdfDetection;
  if (latestCaptureByTab.get(tabId) !== captureId) return;
  const selectedText = String(info.selectionText || "");
  const hasSelection = Boolean(selectedText.trim());
  const captureMode =
    isChromePdf
      ? hasSelection
        ? "selection"
        : "full-pdf"
      : hasSelection
        ? "selection"
        : "full-page";
  const extraction =
    captureMode === "full-pdf"
      ? { text: "", error: null }
      : isChromePdf
        ? capturePdfSelection(selectedText)
        : captureMode === "selection"
          ? await captureSelection(
              tabId,
              frameId,
              selectedText,
              captureId,
              contentReady
            )
          : await capturePage(
              tabId,
              frameId,
              captureId,
              contentReady,
              info.forceFullPage === true
            );
  if (latestCaptureByTab.get(tabId) !== captureId) return;
  // The frame's own report of what it captured wins over the click's intent:
  // it may have had an exact selection snapshotted, and a top-level YouTube
  // watch page answers a full-page capture with the video's subtitle
  // transcript rather than the shell rendered around the player.
  const effectiveCaptureMode =
    !isChromePdf &&
    captureMode === "full-page" &&
    (extraction.captureMode === "selection" ||
      extraction.captureMode === "video-transcript")
      ? extraction.captureMode
      : captureMode;
  const payload = {
    captureId,
    capturedAt,
    tabId,
    windowId: tab.windowId,
    frameId,
    captureMode: effectiveCaptureMode,
    intent,
    text: extraction.text || "",
    error: extraction.error || null,
    truncated: extraction.truncated === true,
    // A watch page whose captions could not be read falls back to page text;
    // the panel says so rather than silently summarising the page shell.
    transcriptUnavailable: extraction.transcriptUnavailable === true,
    sourceType: isChromePdf ? PDF_SOURCE_TYPE : "page",
    url: tab.url || info.pageUrl || null,
  };

  // `seededAt` stamps the write itself (capturedAt is the click). A panel that
  // opens much later can expire a seed the user has moved on from. One key per
  // tab, written with `set`, so a new capture replaces the previous seed whole.
  await chrome.storage.session.set({
    [seedKey(tabId)]: { ...payload, seededAt: Date.now() },
  });
  if (latestCaptureByTab.get(tabId) !== captureId) return;

  // Notify the panel if it's already listening. Ignore "no receiver" errors.
  chrome.runtime
    .sendMessage({ type: "selection-captured", ...payload })
    .catch(() => {});
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "capture-tab-for-chat") {
    chrome.tabs
      .get(message.tabId)
      .then((tab) =>
        captureAndOpen(
          "ask",
          { frameId: 0, forceFullPage: true },
          tab,
          false
        )
      )
      .then(() => sendResponse({ ok: true }))
      .catch(() =>
        sendResponse({
          ok: false,
          error: "Couldn't read this page.",
        })
      );
    return true;
  }

  if (message?.type === "clear-tab-highlights") {
    const tabId = validTabId(message.tabId);
    if (tabId == null) {
      sendResponse({ ok: false });
      return false;
    }
    warmContentScript(tabId, 0)
      .then(() =>
        chrome.tabs.sendMessage(tabId, { type: "clear-highlight" })
      )
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }

  if (
    message?.type !== "highlight-pdf-source" &&
    message?.type !== "clear-pdf-source-highlight" &&
    message?.type !== "cancel-pdf-source-operation"
  ) {
    return false;
  }

  const operation =
    message.type === "highlight-pdf-source"
      ? highlightPdfSource(message)
      : message.type === "clear-pdf-source-highlight"
        ? clearPdfSourceHighlight(message)
        : cancelPdfSourceOperation(message);
  operation
    .then(sendResponse)
    .catch((error) => {
      console.warn("[TokenPath] PDF highlight failed:", error);
      sendResponse({
        ok: false,
        error: "Couldn't highlight that text in Chrome's PDF viewer.",
      });
    });
  return true;
});

function seedKey(tabId) {
  return "seed:" + tabId;
}

function warmContentScript(tabId, frameId) {
  const target = { tabId, frameIds: [frameId] };
  try {
    return Promise.all([
      chrome.scripting.executeScript({ target, files: ["content.js"] }),
      chrome.scripting.insertCSS({ target, files: ["content.css"] }),
    ]).catch(() => {});
  } catch (e) {
    return Promise.resolve();
  }
}

function isChromePdfViewerFrame(frameUrl) {
  return (
    typeof frameUrl === "string" &&
    frameUrl.startsWith(CHROME_PDF_VIEWER_ORIGIN)
  );
}

function detectTopLevelChromePdf(tabId) {
  try {
    return chrome.scripting
      .executeScript({
        target: { tabId },
        func: () => document.contentType,
      })
      .then(
        (results) =>
          Array.isArray(results) &&
          results.some((entry) => entry?.result === "application/pdf")
      )
      .catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

function capturePdfSelection(selectionText) {
  const text = String(selectionText || "").trim();
  return text
    ? { text, error: null }
    : {
        text: "",
        error: "No text was captured from this PDF. Select some text and try again.",
      };
}

async function captureSelection(
  tabId,
  frameId,
  selectionText,
  captureId,
  contentReady
) {
  return captureFromPageFrame(
    tabId,
    frameId,
    { type: "capture-selection", selectionText, captureId },
    contentReady,
    "selection"
  );
}

async function capturePage(
  tabId,
  frameId,
  captureId,
  contentReady,
  forceFullPage = false
) {
  return captureFromPageFrame(
    tabId,
    frameId,
    { type: "capture-page", captureId, forceFullPage },
    contentReady,
    "page"
  );
}

async function captureFromPageFrame(
  tabId,
  frameId,
  message,
  contentReady,
  target
) {
  let first = null;
  try {
    first = await chrome.tabs.sendMessage(
      tabId,
      message,
      { frameId }
    );
    if (first && !first.error) return first;
  } catch (e) {
    // A missing receiver is expected for a tab that predates installation.
  }

  // A stale/older listener can also answer with a content-level error before
  // the proactive injection has installed the current code. Wait for it and
  // retry exactly once for either kind of failure.
  try {
    await contentReady;
    const retried = await chrome.tabs.sendMessage(
      tabId,
      message,
      { frameId }
    );
    return retried || first || captureFailure(target);
  } catch (e) {
    console.warn(`[TokenPath] ${message.type} failed:`, e);
    return first || captureFailure(target);
  }
}

function captureFailure(target) {
  return {
    text: "",
    error:
      target === "page"
        ? "Couldn't read this page (it may be a restricted page such as chrome:// or the Web Store)."
        : "Couldn't read the selection on this page (it may be a restricted page such as chrome:// or the Web Store).",
  };
}

async function highlightPdfSource(message) {
  const tabId = validTabId(message?.tabId);
  const pdfUrl = validPdfUrl(message?.url);
  const textFragment = buildPdfTextFragment(
    message?.document,
    message?.start,
    message?.end
  );
  if (tabId == null || !pdfUrl || !textFragment) {
    return { ok: false, error: "The PDF source range is no longer available." };
  }
  const operationId = beginPdfOperation(tabId);
  const showsPdf = await pdfTabStillShows(tabId, pdfUrl);
  if (!isCurrentPdfOperation(tabId, operationId)) return { ok: false };
  if (!showsPdf) {
    await forgetAppliedPdfUrl(tabId);
    return { ok: false, error: "The tab is no longer showing that PDF." };
  }

  const targetUrl = withTextFragment(pdfUrl, textFragment);
  // Compare against what this worker last applied, never against the tab's
  // live URL: Chrome strips the `:~:` directive from both location.href and
  // tabs.url as soon as it consumes it, so a live-URL comparison can never
  // match and every repeat click would reload the PDF again.
  if (sameUrl(await readAppliedPdfUrl(tabId), targetUrl)) {
    return isCurrentPdfOperation(tabId, operationId)
      ? { ok: true }
      : { ok: false };
  }
  const didReload = await navigatePdfAndReload(
    tabId,
    targetUrl,
    operationId
  );
  if (!didReload || !isCurrentPdfOperation(tabId, operationId)) {
    return { ok: false };
  }
  await writeAppliedPdfUrl(tabId, targetUrl);
  return { ok: true };
}

// Clearing has two very different costs, so it has two modes.
//
// The default mode only rewrites the tab's URL in place: the directive leaves
// the address bar, but the highlight PDFium already painted stays on screen
// until the PDF's next natural load. This is what every implicit clear uses —
// closing the panel, replacing a capture, clearing the chat — because none of
// those is a request to reload the user's document, and reloading resets the
// viewer to page 1.
//
// `reload: true` is reserved for the explicit "Clear highlight" button. Chrome
// exposes no way to unpaint a text fragment other than loading the document
// again, so an explicit user request to clear is allowed to cost one reload —
// and only that request.
async function clearPdfSourceHighlight(message) {
  const tabId = validTabId(message?.tabId);
  const pdfUrl = validPdfUrl(message?.url);
  if (tabId == null || !pdfUrl) return { ok: false };
  const unpaint = message?.reload === true;
  const operationId = beginPdfOperation(tabId);
  const showsPdf = await pdfTabStillShows(tabId, pdfUrl);
  if (!isCurrentPdfOperation(tabId, operationId)) return { ok: false };
  if (!showsPdf) {
    await forgetAppliedPdfUrl(tabId);
    return { ok: false };
  }

  const targetUrl = withoutTextFragment(pdfUrl);
  if (!unpaint && sameUrl(await readAppliedPdfUrl(tabId), targetUrl)) {
    return isCurrentPdfOperation(tabId, operationId)
      ? { ok: true }
      : { ok: false };
  }
  if (!isCurrentPdfOperation(tabId, operationId)) return { ok: false };
  // If the capture URL did not contain a text fragment, the controller only
  // calls this after a successful PDF highlight, whose applied URL does.
  const applied = unpaint
    ? await navigatePdfAndReload(tabId, targetUrl, operationId)
    : await replacePdfTabUrl(tabId, targetUrl);
  if (!applied || !isCurrentPdfOperation(tabId, operationId)) {
    return { ok: false };
  }
  await writeAppliedPdfUrl(tabId, targetUrl);
  return { ok: true };
}

function appliedPdfUrlKey(tabId) {
  return PDF_APPLIED_URL_PREFIX + tabId;
}

async function readAppliedPdfUrl(tabId) {
  try {
    const key = appliedPdfUrlKey(tabId);
    const stored = await chrome.storage.session.get(key);
    const value = stored?.[key];
    return typeof value === "string" ? value : null;
  } catch {
    // An unreadable record only costs one redundant reload; never a wrong one.
    return null;
  }
}

async function writeAppliedPdfUrl(tabId, url) {
  try {
    await chrome.storage.session.set({ [appliedPdfUrlKey(tabId)]: url });
  } catch {
    // Same fail-open trade as reading: the highlight itself already landed.
  }
}

async function forgetAppliedPdfUrl(tabId) {
  try {
    await chrome.storage.session.remove?.(appliedPdfUrlKey(tabId));
  } catch {
    // Nothing to do: the record is only ever used as a same-URL short-circuit.
  }
}

function cancelPdfSourceOperation(message) {
  const tabId = validTabId(message?.tabId);
  if (tabId == null) return Promise.resolve({ ok: false });
  beginPdfOperation(tabId);
  return Promise.resolve({ ok: true });
}

function validTabId(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}

function validPdfUrl(value) {
  if (typeof value !== "string" || !value || value.length > 65_536) return null;
  try {
    const parsed = new URL(value);
    return ["https:", "http:", "file:", "blob:", "ftp:"].includes(
      parsed.protocol
    )
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

// Whether the tab is still showing the PDF resource the panel captured,
// ignoring fragments. Identity only: neither Chrome API reports a live
// `:~:text=` directive back, so this can never say whether a highlight is
// currently painted.
async function pdfTabStillShows(tabId, pdfUrl) {
  try {
    const tab = await chrome.tabs.get(tabId);
    if (typeof tab?.url === "string" && tab.url) {
      return samePdfResourceUrl(tab.url, pdfUrl);
    }
  } catch {
    // Fall through to an activeTab-scoped probe.
  }

  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        contentType: document.contentType,
        url: location.href,
      }),
    });
    return Array.isArray(results)
      ? results.some(
          (entry) =>
            entry?.result?.contentType === "application/pdf" &&
            samePdfResourceUrl(entry.result.url, pdfUrl)
        )
      : false;
  } catch {
    // If Chrome revoked activeTab after a real navigation, failing closed is
    // essential: a stale side panel must never navigate back to the old PDF.
    return false;
  }
}

function samePdfResourceUrl(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  try {
    const leftUrl = new URL(left);
    const rightUrl = new URL(right);
    leftUrl.hash = "";
    rightUrl.hash = "";
    return leftUrl.href === rightUrl.href;
  } catch {
    return left.split("#", 1)[0] === right.split("#", 1)[0];
  }
}

function buildPdfTextFragment(documentText, rawStart, rawEnd) {
  const document = String(documentText || "");
  if (
    !document ||
    !Number.isInteger(rawStart) ||
    !Number.isInteger(rawEnd) ||
    rawStart < 0 ||
    rawEnd <= rawStart ||
    rawEnd > document.length
  ) {
    return null;
  }

  let start = rawStart;
  let end = rawEnd;
  if (
    isLowSurrogate(document.charCodeAt(start)) &&
    isHighSurrogate(document.charCodeAt(start - 1))
  ) {
    start--;
  }
  if (
    isHighSurrogate(document.charCodeAt(end - 1)) &&
    isLowSurrogate(document.charCodeAt(end))
  ) {
    end++;
  }
  while (start < end && /\s/u.test(document[start])) start++;
  while (end > start && /\s/u.test(document[end - 1])) end--;
  const target = normalizePdfFragmentText(safePdfSlice(document, start, end));
  if (!target) return null;

  const prefix = pdfFragmentContext(
    safePdfSlice(
      document,
      Math.max(0, start - PDF_FRAGMENT_CONTEXT_CHARS * 2),
      start
    ),
    "end"
  );
  const suffix = pdfFragmentContext(
    safePdfSlice(
      document,
      end,
      Math.min(document.length, end + PDF_FRAGMENT_CONTEXT_CHARS * 2)
    ),
    "start"
  );
  const targetCodePoints = Array.from(target);
  const textStart =
    targetCodePoints.length <= PDF_FRAGMENT_FULL_TARGET_CHARS
      ? target
      : pdfFragmentContext(target, "start", PDF_FRAGMENT_EDGE_CHARS);
  const textEnd =
    targetCodePoints.length <= PDF_FRAGMENT_FULL_TARGET_CHARS
      ? ""
      : pdfFragmentContext(target, "end", PDF_FRAGMENT_EDGE_CHARS);

  return (
    (prefix ? `${encodePdfFragmentPart(prefix)}-,` : "") +
    encodePdfFragmentPart(textStart) +
    (textEnd ? `,${encodePdfFragmentPart(textEnd)}` : "") +
    (suffix ? `,-${encodePdfFragmentPart(suffix)}` : "")
  );
}

function safePdfSlice(value, rawStart, rawEnd) {
  let start = Math.max(0, rawStart);
  let end = Math.min(value.length, rawEnd);
  if (
    isLowSurrogate(value.charCodeAt(start)) &&
    isHighSurrogate(value.charCodeAt(start - 1))
  ) {
    start--;
  }
  if (
    isHighSurrogate(value.charCodeAt(end - 1)) &&
    isLowSurrogate(value.charCodeAt(end))
  ) {
    end++;
  }
  return value.slice(start, end);
}

function isHighSurrogate(codeUnit) {
  return codeUnit >= 0xd800 && codeUnit <= 0xdbff;
}

function isLowSurrogate(codeUnit) {
  return codeUnit >= 0xdc00 && codeUnit <= 0xdfff;
}

function normalizePdfFragmentText(value) {
  return String(value || "")
    // Soft/zero-width separators are commonly injected into extracted PDF
    // text. Keep ZWNJ/ZWJ: unlike those separators, they can be meaningful
    // parts of Persian text and emoji sequences.
    .replace(/[\u00ad\u200b\u2060\ufeff]/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function pdfFragmentContext(
  value,
  edge,
  maxCharacters = PDF_FRAGMENT_CONTEXT_CHARS
) {
  const clean = normalizePdfFragmentText(value);
  if (!clean) return "";
  const codePoints = Array.from(clean);
  if (codePoints.length <= maxCharacters) return clean;

  const clipped =
    edge === "end"
      ? codePoints.slice(-maxCharacters).join("")
      : codePoints.slice(0, maxCharacters).join("");
  // Prefer whole words, but keep the clipped text for scripts without spaces.
  if (!/\s/u.test(clipped)) return clipped;
  return edge === "end"
    ? clipped.replace(/^\S+\s+/u, "")
    : clipped.replace(/\s+\S*$/u, "");
}

function encodePdfFragmentPart(value) {
  // Text-fragment commas and `-,` / `,-` pairs are structural. Encode every
  // punctuation character that encodeURIComponent leaves unescaped so source
  // prose cannot accidentally become part of the directive grammar.
  return encodeURIComponent(value).replace(
    /[!'()*-]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`
  );
}

function withTextFragment(rawUrl, directive) {
  const base = withoutTextFragment(rawUrl);
  return base.includes("#")
    ? `${base}:~:text=${directive}`
    : `${base}#:~:text=${directive}`;
}

function withoutTextFragment(rawUrl) {
  const hashIndex = rawUrl.indexOf("#");
  if (hashIndex < 0) return rawUrl;
  const directiveIndex = rawUrl.indexOf(":~:", hashIndex + 1);
  if (directiveIndex < 0) return rawUrl;
  const base = rawUrl.slice(0, directiveIndex);
  return base.endsWith("#") ? base.slice(0, -1) : base;
}

function beginPdfOperation(tabId) {
  const operationId = `${Date.now()}:${Math.random()}`;
  latestPdfOperationByTab.set(tabId, operationId);
  return operationId;
}

function isCurrentPdfOperation(tabId, operationId) {
  return latestPdfOperationByTab.get(tabId) === operationId;
}

// Rewrites the PDF tab's own URL in place, without loading anything.
//
// Chrome's native viewer renders the PDF inside an ordinary, scriptable
// top-level HTML document (no embed, no subframes, and no viewer API), so an
// ISOLATED-world injection can call history.replaceState on it: zero loads and
// zero session-history entries, where chrome.tabs.update costs one Back entry
// per fragment change. The directive only takes effect on the next load, which
// is why the callers that want a visible highlight follow this with a reload.
async function replacePdfTabUrl(tabId, targetUrl) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: (url) => {
        history.replaceState(null, "", url);
        return true;
      },
      args: [targetUrl],
    });
    return (
      Array.isArray(results) &&
      results.some((entry) => entry?.result === true)
    );
  } catch {
    // Restricted contexts (a revoked activeTab, a policy-blocked tab) cannot
    // be injected. The caller decides whether the operation is worth a real
    // navigation instead.
    return false;
  }
}

async function navigatePdfAndReload(tabId, targetUrl, operationId) {
  if (!isCurrentPdfOperation(tabId, operationId)) return false;
  const replaced = await replacePdfTabUrl(tabId, targetUrl);
  if (!isCurrentPdfOperation(tabId, operationId)) return false;
  if (replaced) {
    // One load total, and the Back button still goes where the user expects.
    await chrome.tabs.reload(tabId);
    return true;
  }

  // Fallback for tabs that cannot be injected: navigate to the fragment URL,
  // wait for it to commit, then reload. Same single visible load, but it does
  // grow the tab's Back history by one entry.
  const committed = observeCommittedTabUrl(tabId, targetUrl);
  try {
    await chrome.tabs.update(tabId, { url: targetUrl });
  } catch (error) {
    committed.cancel();
    throw error;
  }

  const didCommit = await committed.promise;
  if (!didCommit || !isCurrentPdfOperation(tabId, operationId)) return false;
  await chrome.tabs.reload(tabId);
  return true;
}

// Only the chrome.tabs.update fallback above needs this: a fragment
// replacement resolves when the injection returns, with nothing to wait for.
function observeCommittedTabUrl(tabId, targetUrl) {
  let settled = false;
  let canObserveUrl = false;
  let sawLoading = false;
  let timeoutId = null;
  let resolvePromise;
  const promise = new Promise((resolve) => {
    resolvePromise = resolve;
  });
  const finish = (didCommit) => {
    if (settled) return;
    settled = true;
    if (timeoutId != null) clearTimeout(timeoutId);
    chrome.tabs.onUpdated.removeListener(listener);
    resolvePromise(didCommit);
  };
  const listener = (updatedTabId, changeInfo, tab) => {
    if (updatedTabId !== tabId) return;
    const visibleUrls = [changeInfo?.url, tab?.url].filter(
      (value) => typeof value === "string" && value
    );
    if (visibleUrls.some((url) => sameUrl(url, targetUrl))) {
      finish(true);
      return;
    }
    if (visibleUrls.length) {
      // With activeTab access, correlate the exact target instead of letting a
      // rapid older navigation's loading/complete pair satisfy this waiter.
      canObserveUrl = true;
      return;
    }
    if (!canObserveUrl && changeInfo?.status === "loading") {
      sawLoading = true;
    } else if (
      !canObserveUrl &&
      sawLoading &&
      changeInfo?.status === "complete"
    ) {
      // URL fields can be filtered without the broad `tabs` permission. A
      // navigation lifecycle is the safe fallback for the same operation.
      finish(true);
    }
  };
  chrome.tabs.onUpdated.addListener(listener);
  timeoutId = setTimeout(() => finish(false), PDF_URL_COMMIT_TIMEOUT_MS);
  return {
    cancel: () => finish(false),
    promise,
  };
}

function sameUrl(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  try {
    return new URL(left).href === new URL(right).href;
  } catch {
    return left === right;
  }
}
