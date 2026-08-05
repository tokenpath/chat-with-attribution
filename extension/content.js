// TokenPath — content script.
// Owns the node map: char offsets in the extracted text -> live Text nodes.
// The map NEVER crosses the message boundary; the panel only exchanges
// { text } and { start, end } char offsets with us.

(() => {
  // Guard against same-version double-injection (manifest + on-demand
  // scripting.executeScript). A versioned marker lets a fresh script replace a
  // stale isolated-world listener after an unpacked extension reload.
  const CONTENT_VERSION = "2026-07-29.1";
  const tokenpathWindow =
    /** @type {Window & { __tokenpathContentLoaded?: string }} */ (window);
  if (tokenpathWindow.__tokenpathContentLoaded === CONTENT_VERSION) return;
  tokenpathWindow.__tokenpathContentLoaded = CONTENT_VERSION;

  const HL_NAME = "tokenpath-attrib";
  const HL_NAME_DARK = "tokenpath-attrib-dark";
  // Below this relative luminance the backdrop behind an attribution is dark
  // enough that the light-page highlight palette turns into murky olive.
  const DARK_BACKDROP_LUMINANCE = 0.4;
  const QUOTE_CONTEXT_LENGTH = 48;
  const MAX_QUOTE_MATCHES = 256;
  const MAX_QUOTE_SOURCE_LENGTH = 500_000;
  const MAX_CAPTURE_CONTEXT_SOURCE_LENGTH = 100_000;
  const MAX_FULL_PAGE_SOURCE_LENGTH = 400_000;
  const MAX_FULL_PAGE_RAW_SOURCE_LENGTH = 2_000_000;
  const MAX_FULL_PAGE_MAP_ENTRIES = 50_000;
  const MAX_FULL_PAGE_TEXT_NODES = 100_000;

  // YouTube's time parameters move the playhead inside one video rather than
  // naming a different document, so they are excluded from route identity.
  // chat-cache.ts applies the identical host-scoped rule to the page-chat key
  // and the navigation guard; the two must agree.
  const YOUTUBE_TIME_PARAMETERS = ["t", "start", "time_continue"];
  const TRANSCRIPT_TIMEOUT_MS = 8_000;
  const MAX_TRANSCRIPT_BODY_LENGTH = 20_000_000;
  const MAX_WATCH_PAGE_SCAN_LENGTH = 8_000_000;
  const MAX_TRANSCRIPT_CUES = 40_000;
  const MAX_PANEL_NODES = 400_000;
  const MAX_PANEL_DEPTH = 48;
  const TRANSCRIPT_PANEL_ID = "PAmodern_transcript_view";
  // The watch page publishes its InnerTube app version inline. If that read
  // ever fails, a recent known-good version is tried rather than giving up —
  // the endpoint tolerates a slightly stale client version.
  const TRANSCRIPT_CLIENT_VERSION_FALLBACK = "2.20260729.00.00";
  const SEEK_INDICATOR_ID = "tokenpath-transcript-seek-indicator";
  const SEEK_INDICATOR_MS = 2_400;
  // Land a moment before the passage begins so its first words are not clipped.
  const SEEK_PREROLL_MS = 2_000;
  // However wide the supporting passage is, never start playback further than
  // this before the cited moment: a topic discussed across a long stretch
  // would otherwise seek minutes away from the phrase that was clicked.
  const MAX_SEEK_LEAD_MS = 60_000;

  // The live Range snapshotted at contextmenu time (before the menu click can
  // collapse the visible selection).
  let storedRange = null;
  let pendingExtraction = null;

  // Last extraction: { text, map, error }. map entries:
  //   { start, end, node, rawOffsets }
  // where start/end are offsets into `text`, and rawOffsets[i] is the raw
  // node.data offset of the extraction char at position (start + i).
  //
  // A YouTube watch-page capture is the same kind of state in the same place:
  // `videoTranscript: true`, an empty node map, and a private cue table
  //   { start, end, tStartMs }
  // whose start/end are UTF-16 offsets into `text`. Like the node map, the cue
  // table NEVER crosses the message boundary — only the plain transcript text
  // travels to the panel and the API.
  let extraction = null;

  let highlight = null;
  let activeHighlightId = null;
  let seekIndicator = null;
  let seekIndicatorTimer = null;

  // --- Selection snapshot ---------------------------------------------------

  function isActiveInstance() {
    return tokenpathWindow.__tokenpathContentLoaded === CONTENT_VERSION;
  }

  function liveSelectionRange() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return null;
    }
    const range = selection.getRangeAt(0);
    if (range.startContainer.ownerDocument !== document) return null;
    return range.cloneRange();
  }

  function rememberLiveSelection(eagerlyExtract) {
    const range = liveSelectionRange();
    if (!range) {
      if (eagerlyExtract) pendingExtraction = null;
      return;
    }
    if (!eagerlyExtract && storedRange && sameRange(range, storedRange)) {
      return;
    }
    storedRange = range;
    // Keep the active captured extraction available for the open answer while
    // preparing the next context-menu capture separately. Chrome's flattened
    // selectionText is only a hint; Gmail/X can normalize invisible characters
    // differently from the exact DOM Range.
    //
    // This runs on every right-click, including the ones that never reach a
    // TokenPath menu item, so the expensive scope/block quote contexts are
    // deferred until a capture message actually arrives.
    if (eagerlyExtract) pendingExtraction = extractFromRange(range, true);
  }

  function sameRange(a, b) {
    return (
      a.startContainer === b.startContainer &&
      a.startOffset === b.startOffset &&
      a.endContainer === b.endContainer &&
      a.endOffset === b.endOffset
    );
  }

  document.addEventListener(
    "selectionchange",
    () => {
      if (isActiveInstance()) rememberLiveSelection(false);
    },
    true
  );
  document.addEventListener(
    "contextmenu",
    () => {
      if (isActiveInstance()) rememberLiveSelection(true);
    },
    true
  );

  // On-demand injection into a tab that predates extension installation/reload
  // happens after the contextmenu event. Snapshot immediately while the native
  // selection is still live, before the side panel finishes opening.
  rememberLiveSelection(false);

  // --- Message handling -----------------------------------------------------

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    // A newer on-demand injection supersedes this instance. Do not race its
    // response with stale capture/highlight state from an already-open tab.
    if (!isActiveInstance()) return false;
    switch (msg && msg.type) {
      case "capture-selection": {
        const hint = normalizeForComparison(msg.selectionText || "");
        const hadPendingExtraction =
          !!pendingExtraction && !pendingExtraction.error;
        let candidate = pendingExtraction;
        pendingExtraction = null;

        if (!candidate || candidate.error) {
          candidate = extractFromRange(liveSelectionRange() || storedRange);
        }

        if (hint && candidate.error) {
          candidate = extractFromTextHint(msg.selectionText);
        } else if (
          hint &&
          !hadPendingExtraction &&
          normalizeForComparison(candidate.text) !== hint
        ) {
          // Tabs that predate injection may not have an eager contextmenu
          // snapshot. Prefer a unique hint remap when one exists, but never
          // replace a valid live Range with a text-search error.
          const hinted = extractFromTextHint(msg.selectionText);
          if (!hinted.error) candidate = hinted;
        }
        extraction = ensureQuoteContexts(candidate);
        clearHighlight();
        extraction.captureId = msg.captureId || null;
        // The exact DOM map is now owned by `extraction`; the browser's native
        // blue selection is no longer needed and makes the page look stuck in
        // selection mode after the user chooses a TokenPath action.
        sendResponse({ text: extraction.text, error: extraction.error });
        if (!extraction.error) clearNativeSelection();
        break;
      }
      case "capture-page": {
        const exactContextSelection = msg.forceFullPage
          ? { error: "Full-page capture requested." }
          : pendingExtraction && !pendingExtraction.error
            ? pendingExtraction
            : extractFromRange(liveSelectionRange());
        pendingExtraction = null;
        const capturedSelection = !exactContextSelection.error;
        // A YouTube watch page's document is what was said, not the shell
        // rendered around the player. A selection is still a selection: only
        // the full-page path becomes a transcript capture.
        if (!capturedSelection && isVideoTranscriptFrame()) {
          captureVideoTranscript()
            .catch(() => null)
            .then((transcript) => {
              if (!isActiveInstance()) return;
              extraction = transcript || extractFullPage();
              clearHighlight();
              extraction.captureId = msg.captureId || null;
              respond(sendResponse, {
                captureMode: transcript ? "video-transcript" : "full-page",
                text: extraction.text,
                error: extraction.error,
                truncated: extraction.truncated === true,
                // The panel says why it is showing page text for a video.
                transcriptUnavailable: !transcript,
              });
            });
          return true;
        }
        extraction = capturedSelection
          ? ensureQuoteContexts(exactContextSelection)
          : extractFullPage();
        clearHighlight();
        extraction.captureId = msg.captureId || null;
        sendResponse({
          captureMode: capturedSelection ? "selection" : "full-page",
          text: extraction.text,
          error: extraction.error,
          truncated: extraction.truncated === true,
        });
        if (capturedSelection) clearNativeSelection();
        break;
      }
      case "highlight": {
        const cachedDocument =
          typeof msg.document === "string" ? msg.document : "";
        // A capture this frame does not hold — a content script that reloaded
        // with its page, or one a newer capture has already replaced — has no
        // live map to trust and none to protect. Only then may the cached
        // source document stand in for the lost extraction.
        const foreignCapture =
          !extraction ||
          Boolean(msg.captureId && msg.captureId !== extraction.captureId);

        // A transcript capture resolves to a caption cue and seeks the player.
        // There is no DOM range to paint, and no cue means no citation.
        if (!foreignCapture && extraction?.videoTranscript) {
          const seeked = seekToTranscriptSpan(
            msg.start,
            msg.end,
            msg.contextStart,
            msg.contextEnd
          );
          if (seeked) activeHighlightId = messageHighlightId(msg);
          sendResponse({ ok: seeked });
          break;
        }
        // After a reload this frame holds no cue table at all. Rebuild it on
        // demand — the same lazy pattern restoreExtractionForHighlight uses
        // for a lost node map — before falling back to page-text recovery.
        if (foreignCapture && cachedDocument && isVideoTranscriptFrame()) {
          restoreTranscriptForHighlight(cachedDocument, msg.captureId)
            .catch(() => false)
            .then((restored) => {
              if (!isActiveInstance()) return;
              const ok = restored
                ? seekToTranscriptSpan(
                    msg.start,
                    msg.end,
                    msg.contextStart,
                    msg.contextEnd
                  )
                : highlightFromCachedDocument(cachedDocument, msg);
              if (ok) activeHighlightId = messageHighlightId(msg);
              respond(sendResponse, { ok });
            });
          return true;
        }

        if (foreignCapture && cachedDocument) {
          restoreExtractionForHighlight(cachedDocument, msg.captureId);
        }
        let ok =
          (!msg.captureId || msg.captureId === extraction?.captureId) &&
          highlightRange(msg.start, msg.end);
        // Restoring the whole map above needs the reloaded page to still match
        // the cached document exactly, and one live counter, ad slot, or
        // relative timestamp anywhere on the page is enough to break that.
        // Locating a single attributed quote never needed the whole document.
        if (!ok && foreignCapture && cachedDocument) {
          ok = highlightDocumentQuote(cachedDocument, msg.start, msg.end);
        }
        if (ok) activeHighlightId = messageHighlightId(msg);
        sendResponse({ ok });
        break;
      }
      case "clear-highlight": {
        // A highlight id is minted per attribution click and recorded only
        // after this frame applied that exact highlight, so it proves
        // ownership by itself — including for a highlight recovered from the
        // cached document, where this frame holds no capture to compare.
        const ownsHighlight =
          Boolean(msg.highlightId) && msg.highlightId === activeHighlightId;
        const captureMatches =
          ownsHighlight ||
          !msg.captureId ||
          msg.captureId === extraction?.captureId;
        const highlightMatches =
          !msg.highlightId || msg.highlightId === activeHighlightId;
        const ok = captureMatches && highlightMatches;
        if (ok) clearHighlight();
        sendResponse({ ok });
        break;
      }
      default:
        break;
    }
    // All handlers respond synchronously.
    return false;
  });

  function clearNativeSelection() {
    try {
      const selection = window.getSelection();
      if (selection?.rangeCount && !selection.isCollapsed) {
        selection.removeAllRanges();
      }
    } catch (e) {
      // Visual cleanup is best-effort and must never turn a valid capture into
      // a failed one on an unusual document implementation.
    }
  }

  function messageHighlightId(msg) {
    return typeof msg.highlightId === "string" && msg.highlightId
      ? msg.highlightId
      : null;
  }

  // An asynchronous handler can finish after the panel that asked has gone
  // away. A closed message port is not a capture failure.
  function respond(sendResponse, payload) {
    try {
      sendResponse(payload);
    } catch (e) {
      // The requester is gone; nothing to report to.
    }
  }

  // The page-text half of the reload recovery path, shared by the ordinary and
  // transcript highlight branches.
  function highlightFromCachedDocument(cachedDocument, msg) {
    restoreExtractionForHighlight(cachedDocument, msg.captureId);
    return (
      highlightRange(msg.start, msg.end) ||
      highlightDocumentQuote(cachedDocument, msg.start, msg.end)
    );
  }

  // --- Extraction -----------------------------------------------------------

  function extractFullPage() {
    const root = document.body;
    if (!root) {
      return {
        text: "",
        map: [],
        error: "This page has no readable document body.",
        truncated: false,
      };
    }

    // Full-page capture is not constrained by CSS user-select. Include all
    // rendered text while keeping the same private DOM map used by selection
    // attribution. Stop at the API/storage-safe prefix instead of building and
    // then transferring an unbounded page string.
    const rebuilt = extractFullPageRoot(root);
    if (!rebuilt.text.trim() || !rebuilt.map.length) {
      return {
        text: "",
        map: [],
        error: "No readable text was found on this page.",
        truncated: false,
      };
    }

    return {
      text: rebuilt.text,
      map: rebuilt.map,
      error: null,
      truncated: rebuilt.overflow,
      fullPage: true,
      renderedOnly: true,
      anchor: {
        selector: "body",
        kind: "body",
        routeKey: currentRouteKey(),
      },
    };
  }

  // `deferQuoteContexts` keeps the eager contextmenu snapshot cheap: the exact
  // Range, its normalized text, and its node map are captured immediately,
  // while the two extra full-subtree passes that collect quote contexts wait
  // for ensureQuoteContexts(). The capture message arrives milliseconds later,
  // with the same live DOM.
  function extractFromRange(range, deferQuoteContexts = false) {
    if (!range) {
      return {
        text: "",
        map: [],
        error: "No selection was captured. Select some text and try again.",
      };
    }
    let root = range.commonAncestorContainer;
    if (!root || !root.isConnected) {
      return {
        text: "",
        map: [],
        error: "The page changed; that selection is no longer available.",
      };
    }
    // A TreeWalker only visits descendants. When the selection is inside a
    // single text node, commonAncestorContainer IS that text node (very common
    // — e.g. selecting within one tweet or one sentence), so walk its parent
    // element instead; the acceptNode filter still restricts us to the range.
    if (root.nodeType !== Node.ELEMENT_NODE) {
      root = root.parentElement || root.parentNode;
    }
    if (!root) {
      return { text: "", map: [], error: "No readable text found in the selection." };
    }

    const styleCache = new WeakMap();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
        if (!isVisibleTextNode(node, styleCache)) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    const map = [];
    let text = "";
    let prevBlock = null;
    let prevTextNode = null;
    let node;

    while ((node = walker.nextNode())) {
      let rawStart = 0;
      let rawEnd = node.data.length;
      if (node === range.startContainer) rawStart = range.startOffset;
      if (node === range.endContainer) rawEnd = range.endOffset;
      if (rawStart >= rawEnd) continue;

      const { out, rawOffsets } = normalizeSlice(node.data, rawStart, rawEnd);
      if (!out) continue;

      // Insert a newline between block-level boundaries so the LLM sees
      // paragraph structure.
      const block = nearestBlock(node, styleCache);
      if (
        text.length > 0 &&
        (block !== prevBlock || hasLineBreakBetween(prevTextNode, node, root))
      ) {
        text += "\n";
      }
      prevBlock = block;
      prevTextNode = node;

      const start = text.length;
      text += out;
      map.push({
        start,
        end: text.length,
        node,
        rawOffsets,
        messageAnchor: makeWhatsAppMessageAnchor(node),
      });
    }

    if (!text) {
      return {
        text: "",
        map: [],
        error: "No readable text found in the selection.",
      };
    }
    const anchor = makeRangeAnchor(range);
    attachAnchorPaths(map, anchor);
    if (!deferQuoteContexts) attachScopeQuoteContexts(map, anchor);
    return {
      text,
      map,
      error: null,
      anchor,
      pendingQuoteContexts: deferQuoteContexts,
    };
  }

  // Attach the deferred quote contexts of an eager contextmenu snapshot. Any
  // other extraction already carries them (or never had any) and is returned
  // unchanged.
  function ensureQuoteContexts(candidate) {
    if (!candidate?.pendingQuoteContexts || candidate.error) return candidate;
    candidate.pendingQuoteContexts = false;
    attachScopeQuoteContexts(candidate.map, candidate.anchor);
    return candidate;
  }

  // Rebuild a page-wide normalized text map only as a mutation fallback. If
  // the complete captured selection occurs exactly once, its absolute source
  // offsets can be rebased onto fresh nodes without searching for (and maybe
  // choosing the wrong copy of) a short phrase such as "Fable 5".
  function refreshDetachedExtraction() {
    if (!extraction || !extraction.text || !document.body) return false;
    if (
      extraction.anchor?.routeKey &&
      extraction.anchor.routeKey !== currentRouteKey()
    ) {
      return false;
    }

    const scope = resolveAnchorScope(extraction.anchor);
    // Rebase only when the complete captured selection is unique inside the
    // source. A saved child path cannot safely choose between repeated quotes
    // after a reorder.
    if (scope && rebaseExtractionWithin(scope)) return true;
    if (scope === document.body) return false;

    // If a stable source identity was captured, never fall through to a body
    // search: the same words may occur in another tweet/message.
    if (isStableAnchor(extraction.anchor)) return false;
    return rebaseExtractionWithin(document.body);
  }

  function rebaseExtractionWithin(scope) {
    const rebuilt = extraction?.fullPage
      ? extractFullPageRoot(scope)
      : extractFromRoot(scope, extraction?.renderedOnly === true);
    const needle = extraction.text;
    const first = rebuilt.text.indexOf(needle);
    if (first < 0 || rebuilt.text.indexOf(needle, first + 1) >= 0) return false;

    const end = first + needle.length;
    const map = sliceMap(rebuilt.map, first, end);
    if (!map.length) return false;
    if (!extraction.fullPage) {
      attachAnchorPaths(map, extraction.anchor);
      attachScopeQuoteContexts(map, extraction.anchor);
    }
    extraction.map = map;
    return true;
  }

  // Gmail and X frequently replace subtrees with structurally equivalent
  // nodes. Preserve a path beneath a stable source identity so the exact Range
  // can be reconstructed before falling back to scoped text matching.
  function makeRangeAnchor(range) {
    let scope =
      range.commonAncestorContainer.nodeType === Node.ELEMENT_NODE
        ? range.commonAncestorContainer
        : range.commonAncestorContainer.parentElement;
    let selector = null;
    let kind = null;
    let statusId = null;
    let articleKey = null;
    const ancestors = [];
    for (let el = scope; el; el = el.parentElement) ancestors.push(el);

    // Prefer durable identities anywhere above the selection over a nearer but
    // ephemeral React wrapper/id.
    for (const el of ancestors) {
      const tweetId = el.getAttribute?.("data-tweet-id");
      if (!tweetId) continue;
      const candidate = `[data-tweet-id="${CSS.escape(tweetId)}"]`;
      if (document.querySelectorAll(candidate).length === 1) {
        scope = el;
        selector = candidate;
        kind = "x-post";
        break;
      }
    }

    // In the logged-in X SPA, identify a tweet by its own status permalink;
    // data-testid="tweet" alone is repeated throughout feeds and replies.
    for (const el of kind ? [] : ancestors) {
      if (el.matches?.('article[data-testid="tweet"]')) {
        const id = findOwnXStatusId(el);
        if (id) {
          scope = el;
          kind = "x-status";
          statusId = id;
          break;
        }
      }
    }

    for (const el of kind ? [] : ancestors) {
      for (const attribute of ["data-message-id", "data-legacy-message-id"]) {
        const value = el.getAttribute?.(attribute);
        if (!value) continue;
        const candidate = `[${attribute}="${CSS.escape(value)}"]`;
        if (document.querySelectorAll(candidate).length === 1) {
          scope = el;
          selector = candidate;
          kind = "gmail-message";
          break;
        }
      }
      if (selector) break;
    }

    for (const el of kind ? [] : ancestors) {
      const testId = el.getAttribute?.("data-testid");
      if (
        testId &&
        [
          "twitterArticleReadView",
          "twitterArticleRichTextView",
          "twitter-article-title",
          "longformRichTextComponent",
        ].includes(testId)
      ) {
        const candidate = `[data-testid="${CSS.escape(testId)}"]`;
        if (document.querySelectorAll(candidate).length === 1) {
          scope = el;
          selector = candidate;
          kind = "x-article";
          break;
        }
      }
    }

    // A single semantic article root is a stable scope across SSR hydration
    // and responsive rerenders even when its internal text nodes are replaced.
    for (const el of kind ? [] : ancestors) {
      const heading = el.matches?.("article")
        ? el.querySelector("h1, h2, h3")
        : null;
      const headingKey = normalizeForComparison(heading?.textContent || "");
      if (
        headingKey &&
        document.querySelectorAll("article").length === 1
      ) {
        scope = el;
        selector = "article";
        kind = "article";
        articleKey = headingKey;
        break;
      }
    }

    for (const el of kind || isXHost() ? [] : ancestors) {
      if (el.id) {
        const candidate = `#${CSS.escape(el.id)}`;
        if (document.querySelectorAll(candidate).length === 1) {
          scope = el;
          selector = candidate;
          kind = "element-id";
          break;
        }
      }
    }
    if (!selector && !kind) {
      scope = document.body;
      selector = "body";
      kind = "body";
    }
    if (!scope) return null;
    const startPath = nodePath(scope, range.startContainer);
    const endPath = nodePath(scope, range.endContainer);
    if (!startPath || !endPath) return null;
    return {
      selector,
      kind,
      statusId,
      articleKey,
      routeKey: currentRouteKey(),
      startPath,
      endPath,
      startOffset: range.startOffset,
      endOffset: range.endOffset,
    };
  }

  function isXHost() {
    return /(^|\.)(x|twitter)\.com$/i.test(location.hostname);
  }

  function currentRouteKey() {
    // Ordinary fragments are scroll positions, not source identity. Preserve
    // hashes only for Gmail and conventional hash-routed SPAs.
    const routeHash =
      location.hostname === "mail.google.com" ||
      /^#(?:!|\/)/.test(location.hash)
        ? location.hash
        : "";
    return (
      location.origin +
      location.pathname +
      currentRouteSearch() +
      routeHash
    );
  }

  // Query parameters are identity — except the host-scoped exceptions that are
  // playback position rather than a different document. Kept in lockstep with
  // chat-cache.ts's stripHostScopedParameters.
  function currentRouteSearch() {
    return isYouTubeIdentityHost(location.hostname)
      ? normalizedYouTubeSearch(location.search)
      : location.search;
  }

  function normalizedYouTubeSearch(search) {
    try {
      const parameters = new URLSearchParams(String(search || ""));
      for (const parameter of YOUTUBE_TIME_PARAMETERS) {
        parameters.delete(parameter);
      }
      const normalized = parameters.toString();
      return normalized ? `?${normalized}` : "";
    } catch (e) {
      return String(search || "");
    }
  }

  function isYouTubeWatchHost(hostname) {
    return /^(?:(?:www|m|music)\.)?youtube\.com$/i.test(String(hostname || ""));
  }

  function isYouTubeIdentityHost(hostname) {
    return (
      isYouTubeWatchHost(hostname) ||
      /^(?:www\.)?youtu\.be$/i.test(String(hostname || ""))
    );
  }

  function findOwnXStatusId(article) {
    for (const link of article.querySelectorAll('a[href*="/status/"]')) {
      if (link.closest('article[data-testid="tweet"]') !== article) continue;
      let pathname;
      try {
        pathname = new URL(link.href, location.href).pathname;
      } catch (e) {
        continue;
      }
      const match = pathname.match(/\/status\/(\d+)/);
      if (match) return match[1];
    }
    return null;
  }

  function nodePath(scope, target) {
    const path = [];
    let node = target;
    while (node && node !== scope) {
      const parent = node.parentNode;
      if (!parent) return null;
      const index = Array.prototype.indexOf.call(parent.childNodes, node);
      if (index < 0) return null;
      path.unshift(index);
      node = parent;
    }
    return node === scope ? path : null;
  }

  function nodeAtPath(scope, path) {
    let node = scope;
    for (const index of path) {
      node = node?.childNodes?.[index];
      if (!node) return null;
    }
    return node;
  }

  function attachAnchorPaths(map, anchor) {
    if (!isStableAnchor(anchor)) return;
    const scope = resolveAnchorScope(anchor);
    if (!scope) return;
    for (const entry of map) {
      entry.anchorPath = nodePath(scope, entry.node);
    }
  }

  // Capture bounded quote context outside each selected Text-node slice. This
  // is still fast and private to the content frame, but gives a later lazy
  // resolver evidence when an attribution consumes a whole node or selection.
  function attachScopeQuoteContexts(map, anchor) {
    const fallbackScope = resolveAnchorScope(anchor) || document.body;
    const groups = new Map();
    for (const entry of map) {
      const scope = entry.messageAnchor
        ? resolveWhatsAppMessageScope(entry.messageAnchor)
        : fallbackScope;
      if (!scope) continue;
      let entries = groups.get(scope);
      if (!entries) {
        entries = [];
        groups.set(scope, entries);
      }
      entries.push(entry);
    }

    for (const [scope, entries] of groups) {
      attachQuoteContextsFromRoot(
        entries,
        scope,
        "scopePrefix",
        "scopeSuffix"
      );
    }

    // A nearest-block context follows a paragraph when it is reordered, while
    // the broader semantic-scope context helps when wrappers disappear.
    const blockGroups = new Map();
    const styleCache = new WeakMap();
    for (const entry of map) {
      const block = nearestBlock(entry.node, styleCache);
      if (!block) continue;
      let entries = blockGroups.get(block);
      if (!entries) {
        entries = [];
        blockGroups.set(block, entries);
      }
      entries.push(entry);
    }
    for (const [block, entries] of blockGroups) {
      attachQuoteContextsFromRoot(
        entries,
        block,
        "blockPrefix",
        "blockSuffix"
      );
    }
  }

  function attachQuoteContextsFromRoot(
    entries,
    root,
    prefixKey,
    suffixKey
  ) {
    const rebuilt = extractFromRoot(
      root,
      true,
      MAX_CAPTURE_CONTEXT_SOURCE_LENGTH
    );
    if (rebuilt.overflow) return;
    const projection = buildQuoteProjection(rebuilt.text, rebuilt.map);
    const byNode = new WeakMap();
    for (const freshEntry of rebuilt.map) {
      byNode.set(freshEntry.node, freshEntry);
    }

    for (const entry of entries) {
      const freshEntry = byNode.get(entry.node);
      if (!freshEntry || !entry.rawOffsets.length) continue;
      const firstRawOffset = entry.rawOffsets[0];
      const lastRawOffset = entry.rawOffsets[entry.rawOffsets.length - 1];
      const first = canonicalOffsetForRaw(
        freshEntry,
        firstRawOffset,
        false
      );
      const last = canonicalOffsetForRaw(
        freshEntry,
        lastRawOffset,
        true
      );
      if (!Number.isFinite(first) || !Number.isFinite(last)) continue;

      const projectedStart = lowerBound(
        projection.canonicalOffsets,
        first
      );
      const projectedEnd = upperBound(
        projection.canonicalOffsets,
        last
      );
      entry[prefixKey] = projection.text.slice(
        Math.max(0, projectedStart - QUOTE_CONTEXT_LENGTH),
        projectedStart
      );
      entry[suffixKey] = projection.text.slice(
        projectedEnd,
        projectedEnd + QUOTE_CONTEXT_LENGTH
      );
    }
  }

  function canonicalOffsetForRaw(entry, rawOffset, preferBefore) {
    let candidate = -1;
    for (let index = 0; index < entry.rawOffsets.length; index++) {
      const current = entry.rawOffsets[index];
      if (current === rawOffset) return entry.start + index;
      if (preferBefore) {
        if (current > rawOffset) break;
        candidate = index;
      } else if (current >= rawOffset) {
        return entry.start + index;
      }
    }
    return candidate >= 0 ? entry.start + candidate : null;
  }

  function lowerBound(values, target) {
    let low = 0;
    let high = values.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (values[middle] < target) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  function upperBound(values, target) {
    let low = 0;
    let high = values.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (values[middle] <= target) low = middle + 1;
      else high = middle;
    }
    return low;
  }

  // WhatsApp serializes each message with a durable true_/false_ data-id
  // inside a role=row wrapper. A cross-message selection's common ancestor is
  // the conversation pane, so preserve a path for each mapped text node within
  // its own message as a narrower recovery identity.
  function makeWhatsAppMessageAnchor(node) {
    if (location.hostname !== "web.whatsapp.com") return null;
    const parent = node?.parentElement;
    const row = parent?.closest?.('[role="row"]');
    if (!row) return null;

    let dataId = null;
    for (let element = parent; element; element = element.parentElement) {
      const candidateId = element.getAttribute?.("data-id") || "";
      if (/^(true|false)_/.test(candidateId)) {
        // Keep walking so a quoted-message identity cannot beat the outer
        // identity of the current bubble.
        dataId = candidateId;
      }
      if (element === row) break;
    }
    if (!dataId) {
      const candidates = [
        ...row.querySelectorAll('[data-id^="true_"], [data-id^="false_"]'),
      ];
      if (candidates.length !== 1) return null;
      dataId = candidates[0].getAttribute("data-id");
    }

    const path = nodePath(row, node);
    if (!dataId || !path) return null;
    return { dataId, path };
  }

  function resolveWhatsAppMessageScope(anchor) {
    if (!anchor?.dataId || !Array.isArray(anchor.path)) return null;
    let candidates;
    try {
      const selector = `[data-id="${CSS.escape(anchor.dataId)}"]`;
      candidates = [...document.querySelectorAll(selector)];
    } catch (e) {
      return null;
    }
    if (candidates.length !== 1) return null;
    const identity = candidates[0];
    const row = identity.closest?.('[role="row"]');
    const scope = row || identity;
    return isRenderedElement(scope) ? scope : null;
  }

  function resolveAnchorScope(anchor) {
    if (!anchor) return null;
    if (anchor.kind === "x-status" && anchor.statusId) {
      const candidates = [
        ...document.querySelectorAll('article[data-testid="tweet"]'),
      ].filter((article) => findOwnXStatusId(article) === anchor.statusId);
      const rendered = candidates.filter(isRenderedElement);
      return rendered.length === 1 ? rendered[0] : null;
    }
    if (anchor.kind === "article" && anchor.articleKey) {
      const candidates = [...document.querySelectorAll("article")].filter(
        (article) =>
          normalizeForComparison(
            article.querySelector("h1, h2, h3")?.textContent || ""
          ) === anchor.articleKey
      );
      const rendered = candidates.filter(isRenderedElement);
      return rendered.length === 1 ? rendered[0] : null;
    }
    if (!anchor.selector) return null;
    try {
      const candidates = [...document.querySelectorAll(anchor.selector)];
      const rendered = candidates.filter(isRenderedElement);
      if (isStableAnchor(anchor)) {
        return rendered.length === 1 ? rendered[0] : null;
      }
      if (anchor.kind === "element-id") {
        return rendered.length === 1 ? rendered[0] : null;
      }
      return rendered[0] || candidates[0] || null;
    } catch (e) {
      return null;
    }
  }

  function isStableAnchor(anchor) {
    // A generic element id is a useful fast-path scope, not a semantic source
    // identity. Responsive apps can replace or rename layout roots while the
    // original mapped text nodes remain valid. Gmail/X identities stay strict.
    return (
      !!anchor &&
      anchor.kind !== "body" &&
      anchor.kind !== "element-id"
    );
  }

  function sliceMap(sourceMap, sliceStart, sliceEnd) {
    const map = [];
    for (const entry of sourceMap) {
      if (entry.end <= sliceStart) continue;
      if (entry.start >= sliceEnd) break;
      const overlapStart = Math.max(entry.start, sliceStart);
      const overlapEnd = Math.min(entry.end, sliceEnd);
      const from = overlapStart - entry.start;
      const to = overlapEnd - entry.start;
      map.push({
        start: overlapStart - sliceStart,
        end: overlapEnd - sliceStart,
        node: entry.node,
        rawOffsets: entry.rawOffsets.slice(from, to),
        messageAnchor: entry.messageAnchor || null,
        anchorPath: entry.anchorPath || null,
        scopePrefix: entry.scopePrefix || "",
        scopeSuffix: entry.scopeSuffix || "",
        blockPrefix: entry.blockPrefix || "",
        blockSuffix: entry.blockSuffix || "",
      });
    }
    return map;
  }

  // Last-resort recovery for tabs/frames that predate extension injection: the
  // context-menu API still gives us flattened selectionText. Anchor it only
  // when it has one unique occurrence in the live normalized frame, so this
  // fallback cannot silently choose the wrong duplicate.
  function extractFromTextHint(rawHint) {
    const needle = normalizeForComparison(rawHint);
    if (!needle || !document.body) {
      return {
        text: "",
        map: [],
        error: "No selection was captured. Select some text and try again.",
      };
    }
    const rebuilt = extractFromRoot(document.body);
    let flat = "";
    const canonicalOffsets = [];
    let inWhitespace = false;
    for (let i = 0; i < rebuilt.text.length; i++) {
      const ch = rebuilt.text[i];
      if (isComparisonIgnorable(ch)) continue;
      if (isWs(ch)) {
        if (inWhitespace) continue;
        inWhitespace = true;
        flat += " ";
        canonicalOffsets.push(i);
      } else {
        inWhitespace = false;
        flat += foldComparisonChar(ch);
        canonicalOffsets.push(i);
      }
    }
    const first = flat.indexOf(needle);
    if (first < 0 || flat.indexOf(needle, first + 1) >= 0) {
      return {
        text: "",
        map: [],
        error:
          first < 0
            ? "The page changed before the selection could be captured."
            : "That selection appears more than once. Select it again so TokenPath can keep the exact occurrence.",
      };
    }
    const canonicalStart = canonicalOffsets[first];
    const canonicalEnd = canonicalOffsets[first + needle.length - 1] + 1;
    const text = rebuilt.text.slice(canonicalStart, canonicalEnd);
    const map = sliceMap(rebuilt.map, canonicalStart, canonicalEnd);
    return map.length
      ? {
          text,
          map,
          error: null,
          anchor: {
            selector: "body",
            kind: "body",
            routeKey: currentRouteKey(),
          },
        }
      : { text: "", map: [], error: "No readable text found in the selection." };
  }

  // Completed attribution matrices outlive a content-script instance. After a
  // page refresh or extension reload, rebuild the private DOM map lazily from
  // the cached source text when the user clicks an attributed answer phrase.
  // Exact prefix matching covers full-page captures (including prompt
  // truncation); unique text matching covers selected passages.
  function restoreExtractionForHighlight(documentText, captureId) {
    if (!document.body || !documentText) return false;
    const rebuilt = extractFullPage();
    let candidate = null;
    if (
      !rebuilt.error &&
      rebuilt.text.startsWith(documentText)
    ) {
      const map = sliceMap(rebuilt.map, 0, documentText.length);
      if (map.length) {
        candidate = {
          ...rebuilt,
          text: documentText,
          map,
          truncated: rebuilt.text.length > documentText.length,
        };
      }
    }
    if (!candidate) {
      const selected = extractFromTextHint(documentText);
      if (!selected.error) candidate = selected;
    }
    if (!candidate) return false;
    extraction = candidate;
    extraction.captureId = captureId || null;
    return true;
  }

  // --- YouTube transcript capture -------------------------------------------
  //
  // A watch page is captured as its subtitle transcript. The panel and the API
  // see one plain string; the offset -> timestamp cue table stays here, beside
  // the node map, and an attributed span is answered by seeking the player
  // rather than by painting a DOM range.

  // Only the top-level watch document owns a player. Embedded players, and the
  // YouTube iframes scattered across other sites, keep ordinary page capture.
  function isVideoTranscriptFrame() {
    try {
      if (window !== window.top) return false;
    } catch (e) {
      return false;
    }
    return (
      isYouTubeWatchHost(location.hostname) &&
      location.pathname === "/watch" &&
      Boolean(currentVideoId())
    );
  }

  function currentVideoId() {
    try {
      const id = new URLSearchParams(location.search).get("v") || "";
      return /^[\w-]{5,32}$/.test(id) ? id : "";
    } catch (e) {
      return "";
    }
  }

  async function captureVideoTranscript() {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), TRANSCRIPT_TIMEOUT_MS);
    try {
      const playerResponse = await currentPlayerResponse(abort.signal);
      // The player response still advertises caption availability correctly;
      // only its signed `baseUrl` is unusable (a bare fetch of it, even
      // in-page with the real session, answers 200 with an empty body under
      // proof-of-origin enforcement). It is the availability gate, nothing
      // more — the transcript itself comes from the panel endpoint below,
      // which returns the video's default track. Track preference therefore
      // no longer applies.
      //
      // When the page says there are no captions, believe it and skip the
      // request. When the player response could not be read at all, there is
      // no evidence either way: ask the panel endpoint rather than declaring
      // a captioned video captionless on the strength of a failed page read.
      if (playerResponse && !hasCaptionTracks(playerResponse)) return null;
      const panel = await fetchTranscriptPanel(currentVideoId(), abort.signal);
      if (!panel) return null;
      const segments = transcriptSegmentsFrom(panel);
      if (!segments.length) {
        // A 200 that parses to nothing means the view-model shape moved.
        // Say so distinctly: this is the one failure a field report cannot
        // otherwise distinguish from "this video has no subtitles".
        console.warn(
          "[TokenPath] YouTube transcript panel returned 0 segments from a " +
            "successful response — the get_panel view-model shape may have changed."
        );
        return null;
      }
      const built = buildTranscriptFromSegments(segments);
      if (!built.text || !built.cues.length) return null;
      return {
        text: built.text,
        map: [],
        cues: built.cues,
        error: null,
        truncated: built.truncated,
        videoTranscript: true,
        routeKey: currentRouteKey(),
      };
    } catch (e) {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  // `ytInitialPlayerResponse` is served inline in the watch page's HTML, so the
  // isolated world can read it without any page bridge. It describes whichever
  // document the tab loaded first, though, and YouTube navigates between
  // videos in-app: a response whose videoId is not the current `?v=` is stale
  // and is never used. Re-reading the current watch URL same-origin is the
  // freshest source available without reaching into the main world.
  async function currentPlayerResponse(signal) {
    const inline = readPlayerResponseFromDocument();
    if (playerResponseMatchesCurrentVideo(inline)) return inline;
    let response;
    try {
      response = await fetch(location.href, {
        credentials: "same-origin",
        signal,
      });
    } catch (e) {
      return null;
    }
    if (!response.ok) return null;
    let html;
    try {
      html = (await response.text()).slice(0, MAX_WATCH_PAGE_SCAN_LENGTH);
    } catch (e) {
      return null;
    }
    const refetched = playerResponseFrom(html);
    return playerResponseMatchesCurrentVideo(refetched) ? refetched : null;
  }

  function readPlayerResponseFromDocument() {
    const scripts = document.querySelectorAll("script");
    for (const script of scripts) {
      const source = script.textContent || "";
      if (!source.includes("ytInitialPlayerResponse")) continue;
      const parsed = playerResponseFrom(source);
      if (parsed) return parsed;
    }
    return null;
  }

  function playerResponseFrom(text) {
    const source = String(text || "");
    for (const marker of [
      "ytInitialPlayerResponse = ",
      "ytInitialPlayerResponse=",
      'ytInitialPlayerResponse"] = ',
    ]) {
      const parsed = extractJsonObjectAfter(source, marker);
      if (parsed && typeof parsed === "object") return parsed;
    }
    return null;
  }

  function playerResponseMatchesCurrentVideo(playerResponse) {
    const videoId = playerResponse?.videoDetails?.videoId;
    const current = currentVideoId();
    return Boolean(current) && videoId === current;
  }

  // The assignment is followed by a JSON object that routinely contains braces
  // inside strings, so a regular expression cannot bound it. Scan for the
  // balanced closing brace instead, honouring string and escape state.
  function extractJsonObjectAfter(text, marker) {
    const markerIndex = text.indexOf(marker);
    if (markerIndex < 0) return null;
    const start = text.indexOf("{", markerIndex + marker.length);
    if (start < 0) return null;
    const limit = Math.min(text.length, start + MAX_WATCH_PAGE_SCAN_LENGTH);
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < limit; index++) {
      const character = text[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
      } else if (character === "{") {
        depth++;
      } else if (character === "}") {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(text.slice(start, index + 1));
          } catch (e) {
            return null;
          }
        }
      }
    }
    return null;
  }

  // Availability only. The player response is untrusted page data and nothing
  // in it is fetched, rendered, or used to build a selector.
  function hasCaptionTracks(playerResponse) {
    const tracks =
      playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    return (
      Array.isArray(tracks) &&
      tracks.some(
        (track) => track && typeof track.baseUrl === "string" && track.baseUrl
      )
    );
  }

  // The transcript comes from the watch page's own transcript panel, requested
  // exactly the way the page requests it: same-origin, session cookies, and a
  // minimal WEB client context. No API key, visitor data, or proof-of-origin
  // token is involved.
  async function fetchTranscriptPanel(videoId, signal) {
    const params = transcriptPanelParams(videoId);
    if (!params) return null;
    const detected = innertubeClientVersion();
    const versions =
      detected && detected !== TRANSCRIPT_CLIENT_VERSION_FALLBACK
        ? [detected, TRANSCRIPT_CLIENT_VERSION_FALLBACK]
        : [TRANSCRIPT_CLIENT_VERSION_FALLBACK];
    for (const clientVersion of versions) {
      const panel = await requestTranscriptPanel(params, clientVersion, signal);
      if (panel) return panel;
      if (signal?.aborted) return null;
    }
    return null;
  }

  async function requestTranscriptPanel(params, clientVersion, signal) {
    // Built from location.origin so the request stays same-origin (and keeps
    // its cookies) on www, m, and music alike.
    const endpoint = `${location.origin}/youtubei/v1/get_panel?prettyPrint=false`;
    let response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          context: {
            client: { clientName: "WEB", clientVersion, hl: "en", gl: "US" },
          },
          panelId: TRANSCRIPT_PANEL_ID,
          params,
        }),
        signal,
      });
    } catch (e) {
      return null;
    }
    if (!response.ok) {
      console.warn(
        `[TokenPath] YouTube transcript panel request failed (HTTP ${response.status}).`
      );
      return null;
    }
    try {
      const body = (await response.text()).slice(0, MAX_TRANSCRIPT_BODY_LENGTH);
      const parsed = JSON.parse(body);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch (e) {
      return null;
    }
  }

  // The panel's `params` is a two-field protobuf message — an inner message
  // holding the video id, plus a constant flag — which is short enough to
  // encode by hand rather than carrying a protobuf runtime:
  //
  //   field 149 (0xaa 0x09), length-delimited, containing
  //     field 1 (0x0a) = the ASCII video id
  //     field 3 (0x18) = 1
  //
  // Verified byte-identical to what YouTube's own transcript panel sends.
  function transcriptPanelParams(videoId) {
    const id = String(videoId || "");
    if (!/^[\w-]{1,64}$/.test(id)) return null;
    const bytes = [0xaa, 0x09, id.length + 4, 0x0a, id.length];
    for (let index = 0; index < id.length; index++) {
      bytes.push(id.charCodeAt(index) & 0xff);
    }
    bytes.push(0x18, 0x01);
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    try {
      return btoa(binary);
    } catch (e) {
      return null;
    }
  }

  // Read the app version the page itself is running, the same defensive way
  // the player response is read: inline scripts only, bounded, no page bridge.
  function innertubeClientVersion() {
    const pattern =
      /"INNERTUBE_(?:CONTEXT_)?CLIENT_VERSION"\s*:\s*"([\w.-]{1,32})"/;
    for (const script of document.querySelectorAll("script")) {
      const source = script.textContent || "";
      if (!source.includes("INNERTUBE_")) continue;
      const match = pattern.exec(source.slice(0, MAX_WATCH_PAGE_SCAN_LENGTH));
      if (match) return match[1];
    }
    return TRANSCRIPT_CLIENT_VERSION_FALLBACK;
  }

  // Transcript rows are `transcriptSegmentViewModel` objects nested inside
  // panel/timeline wrappers. Walk the response in document order and take only
  // those: chapter headings and other view-model types sit in the same lists
  // and are not speech. There is no start-time field in this shape — the
  // displayed timestamp is the source, at one-second precision, which is finer
  // than any cue boundary a viewer can perceive.
  function transcriptSegmentsFrom(panel) {
    const segments = [];
    let budget = MAX_PANEL_NODES;
    const visit = (node, depth) => {
      if (
        budget-- <= 0 ||
        depth > MAX_PANEL_DEPTH ||
        segments.length >= MAX_TRANSCRIPT_CUES
      ) {
        return;
      }
      if (Array.isArray(node)) {
        for (const item of node) visit(item, depth + 1);
        return;
      }
      if (!node || typeof node !== "object") return;
      const segment = node.transcriptSegmentViewModel;
      if (segment && typeof segment === "object") {
        const text =
          typeof segment.simpleText === "string" ? segment.simpleText : "";
        const tStartMs = timestampToMs(segment.timestamp);
        if (text.trim() && tStartMs != null) segments.push({ text, tStartMs });
        return;
      }
      for (const key of Object.keys(node)) visit(node[key], depth + 1);
    };
    visit(panel, 0);
    return segments;
  }

  // "0:03", "12:34", "1:02:45" — the transcript panel's own display format.
  function timestampToMs(value) {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    if (!/^\d{1,4}(?::[0-5]?\d){1,2}$/.test(trimmed)) return null;
    let seconds = 0;
    for (const part of trimmed.split(":")) seconds = seconds * 60 + Number(part);
    return Number.isFinite(seconds) ? seconds * 1_000 : null;
  }

  // Cue offsets are UTF-16 indexes into the joined transcript — the same units
  // the panel resolves an attributed span in. Cues are joined with a single
  // space so the transcript reads as prose in the panel and to the model; that
  // separator belongs to no cue, and a span that lands on one resolves to the
  // nearer neighbour. A cue is truncated whole: the source cap never cuts a
  // line in half, so every character of the transcript has a timestamp.
  function buildTranscriptFromSegments(segments, limits) {
    const maxCharacters =
      limits?.maxCharacters ?? MAX_FULL_PAGE_SOURCE_LENGTH;
    const maxCues = limits?.maxCues ?? MAX_TRANSCRIPT_CUES;
    const cues = [];
    let text = "";
    let truncated = false;
    if (!Array.isArray(segments)) return { text, cues, truncated };
    for (const segment of segments) {
      if (cues.length >= maxCues) {
        truncated = true;
        break;
      }
      if (!segment) continue;
      const tStartMs = cueStartMs(segment.tStartMs);
      if (tStartMs == null) continue;
      // A transcript row wraps across two display lines often enough that its
      // own newlines have to collapse before the cue is measured.
      const cueText = String(segment.text || "")
        .replace(/\s+/gu, " ")
        .trim();
      if (!cueText) continue;
      const separator = text ? " " : "";
      if (text.length + separator.length + cueText.length > maxCharacters) {
        truncated = true;
        break;
      }
      text += separator;
      const start = text.length;
      text += cueText;
      cues.push({ start, end: text.length, tStartMs });
    }
    return { text, cues, truncated };
  }

  function cueStartMs(value) {
    const start = Number(value);
    if (!Number.isFinite(start) || start < 0) return null;
    return Math.round(start);
  }

  // The cue an attributed [start, end) came from: the earliest one it overlaps,
  // or — when it landed on a separator between two cues — the nearer
  // neighbour. A span entirely outside the cue table has no timestamp and
  // fails closed rather than seeking somewhere arbitrary.
  function findCueForSpan(cues, start, end) {
    if (!Array.isArray(cues) || !cues.length) return null;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      return null;
    }
    const last = cues[cues.length - 1];
    if (end <= cues[0].start || start >= last.end) return null;

    let low = 0;
    let high = cues.length - 1;
    let index = cues.length;
    while (low <= high) {
      const mid = (low + high) >> 1;
      if (cues[mid].end > start) {
        index = mid;
        high = mid - 1;
      } else {
        low = mid + 1;
      }
    }
    const candidate = index < cues.length ? cues[index] : null;
    if (candidate && candidate.start < end) return candidate;
    const previous = index > 0 ? cues[index - 1] : null;
    if (!candidate) return previous;
    if (!previous) return candidate;
    return start - previous.end <= candidate.start - end ? previous : candidate;
  }

  // The cited span answers "which words support this"; the seek answers "where
  // does this get discussed". They are not the same moment. Given the wider
  // supported range the panel resolved from the same heatmap, start playback at
  // the beginning of that passage instead of mid-sentence on the exact phrase.
  // With no expansion data — a chat restored from an older record, or a
  // selection with no wider support — the exact cue is used unchanged.
  function seekStartMsForSpan(cues, exactCue, contextStart, contextEnd) {
    const exactMs = exactCue.tStartMs;
    let startMs = exactMs;
    if (
      Number.isInteger(contextStart) &&
      Number.isInteger(contextEnd) &&
      contextEnd > contextStart
    ) {
      // Cues tile the transcript, so the earliest cue overlapping the
      // supported range IS the start of the contiguous neighbourhood; a gap
      // wide enough to break contiguity is a gap the panel's own threshold
      // already refused to bridge.
      const opening = findCueForSpan(cues, contextStart, contextEnd);
      if (opening && opening.tStartMs < startMs) startMs = opening.tStartMs;
    }
    // Pre-roll, then the hard lead bound — applied to the final time rather
    // than by picking a different cue, so the bound holds exactly.
    return Math.max(
      0,
      Math.max(startMs - SEEK_PREROLL_MS, exactMs - MAX_SEEK_LEAD_MS)
    );
  }

  function seekToTranscriptSpan(rawStart, rawEnd, contextStart, contextEnd) {
    if (!extraction?.videoTranscript || !extraction.cues?.length) return false;
    if (extraction.routeKey && extraction.routeKey !== currentRouteKey()) {
      return false;
    }
    const { start, end } = clampSpan(extraction.text, rawStart, rawEnd);
    const cue = findCueForSpan(extraction.cues, start, end);
    if (!cue) return false;
    const video = playerVideoElement();
    if (!video) return false;
    const seekMs = seekStartMsForSpan(
      extraction.cues,
      cue,
      contextStart,
      contextEnd
    );
    const seconds = seekMs / 1_000;
    if (!Number.isFinite(seconds)) return false;
    try {
      video.currentTime = Math.max(0, seconds);
    } catch (e) {
      return false;
    }
    // Deliberately no play(): an attribution click asks where an answer came
    // from. Starting audio the user did not ask for is worse than landing
    // paused on the right moment.
    scrollPlayerIntoView(video);
    // The indicator names the cited moment, not the playhead: the citation is
    // the exact phrase's cue however far back playback was started.
    showSeekIndicator(video, cue.tStartMs, seekMs);
    return true;
  }

  function playerVideoElement() {
    // Fixed selectors of our own, never built from page data.
    const player = /** @type {HTMLVideoElement | null} */ (
      document.querySelector("#movie_player video") ||
        document.querySelector("video.html5-main-video") ||
        document.querySelector("video")
    );
    return player && player.isConnected ? player : null;
  }

  function scrollPlayerIntoView(video) {
    try {
      const rect = video.getBoundingClientRect();
      if (rect.top >= 0 && rect.bottom <= window.innerHeight) return;
      const reduced = window.matchMedia?.(
        "(prefers-reduced-motion: reduce)"
      ).matches;
      video.scrollIntoView({
        behavior: reduced ? "auto" : "smooth",
        block: "center",
        inline: "nearest",
      });
    } catch (e) {
      // Scrolling is a convenience; the seek itself already happened.
    }
  }

  // The CSS Custom Highlight API cannot paint inside a <video>, so the source
  // confirmation is a small element of our own, removed after a moment. Its
  // only dynamic content is a timestamp formatted from a number, and every
  // style is a literal: no page-controlled string reaches HTML or CSS.
  function showSeekIndicator(video, citedMs, playFromMs = citedMs) {
    removeSeekIndicator();
    const host = document.body || document.documentElement;
    if (!host) return;
    try {
      const element = document.createElement("div");
      element.id = SEEK_INDICATOR_ID;
      element.setAttribute("role", "status");
      // Both values are formatted from numbers we computed. When playback was
      // moved back to the start of the passage, say so rather than leaving the
      // playhead apparently disagreeing with the cited timestamp.
      const leadIn =
        citedMs - playFromMs > SEEK_PREROLL_MS
          ? ` · from ${formatTimestamp(playFromMs)}`
          : "";
      element.textContent =
        `TokenPath source · ${formatTimestamp(citedMs)}${leadIn}`;
      const rect = video.getBoundingClientRect();
      const top = Math.round(
        Math.max(12, Math.min(window.innerHeight - 56, rect.top + 16))
      );
      const left = Math.round(
        Math.max(12, Math.min(window.innerWidth - 240, rect.left + 16))
      );
      const styles = [
        ["position", "fixed"],
        ["top", `${top}px`],
        ["left", `${left}px`],
        ["z-index", "2147483647"],
        ["margin", "0"],
        ["padding", "6px 10px"],
        ["border-radius", "6px"],
        ["background-color", "rgba(24, 24, 27, 0.92)"],
        ["color", "rgb(255, 231, 148)"],
        ["font", "500 13px/1.3 system-ui, sans-serif"],
        ["pointer-events", "none"],
        ["box-shadow", "0 2px 8px rgba(0, 0, 0, 0.35)"],
      ];
      for (const [property, value] of styles) {
        element.style.setProperty(property, value, "important");
      }
      host.appendChild(element);
      seekIndicator = element;
      seekIndicatorTimer = setTimeout(removeSeekIndicator, SEEK_INDICATOR_MS);
    } catch (e) {
      // Feedback is best-effort; the player has already moved.
    }
  }

  function removeSeekIndicator() {
    if (seekIndicatorTimer != null) {
      clearTimeout(seekIndicatorTimer);
      seekIndicatorTimer = null;
    }
    // Removed through our own reference so a page element that happens to
    // share the id can never be touched.
    if (seekIndicator) {
      seekIndicator.remove();
      seekIndicator = null;
    }
  }

  function formatTimestamp(totalMs) {
    const totalSeconds = Math.max(0, Math.floor(Number(totalMs) / 1_000));
    const hours = Math.floor(totalSeconds / 3_600);
    const minutes = Math.floor((totalSeconds % 3_600) / 60);
    const seconds = totalSeconds % 60;
    const pad = (value) => String(value).padStart(2, "0");
    return hours
      ? `${hours}:${pad(minutes)}:${pad(seconds)}`
      : `${minutes}:${pad(seconds)}`;
  }

  // A reloaded frame holds no cue table, exactly as it holds no node map.
  // Rebuild it from the live page and accept it only if it reproduces the
  // cached transcript the answer was attributed against.
  async function restoreTranscriptForHighlight(documentText, captureId) {
    if (!documentText || !isVideoTranscriptFrame()) return false;
    const rebuilt = await captureVideoTranscript();
    if (!rebuilt) return false;
    if (rebuilt.text === documentText) {
      extraction = rebuilt;
      extraction.captureId = captureId || null;
      return true;
    }
    // A capture bounded by the source cap is a prefix of the full transcript.
    if (rebuilt.text.startsWith(documentText)) {
      const cues = rebuilt.cues
        .filter((cue) => cue.start < documentText.length)
        .map((cue) => ({
          start: cue.start,
          end: Math.min(cue.end, documentText.length),
          tStartMs: cue.tStartMs,
        }));
      if (!cues.length) return false;
      extraction = {
        ...rebuilt,
        text: documentText,
        cues,
        truncated: true,
        captureId: captureId || null,
      };
      return true;
    }
    // Different captions than the ones the answer cites: fail closed.
    return false;
  }

  function normalizeForComparison(text) {
    const normalized = String(text || "")
      .replace(/[\u00ad\u200b-\u200d\u2060\ufeff]/g, "")
      .replace(/\s+/gu, " ")
      .trim();
    return normalized.replace(/[A-Z]/g, foldComparisonChar);
  }

  // CSS text-transform can make Chrome's context-menu selectionText use a
  // different case from the DOM (Substack dates are a current example). Keep
  // folding ASCII-only and length-preserving so canonicalOffsets stay exact.
  function foldComparisonChar(ch) {
    return ch >= "A" && ch <= "Z" ? ch.toLowerCase() : ch;
  }

  function extractFullPageRoot(root) {
    const styleCache = new WeakMap();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const map = [];
    let text = "";
    let prevBlock = null;
    let prevTextNode = null;
    let rawCharacters = 0;
    let visitedTextNodes = 0;
    let node;

    while ((node = walker.nextNode())) {
      visitedTextNodes += 1;
      if (
        visitedTextNodes > MAX_FULL_PAGE_TEXT_NODES ||
        map.length >= MAX_FULL_PAGE_MAP_ENTRIES ||
        rawCharacters >= MAX_FULL_PAGE_RAW_SOURCE_LENGTH ||
        text.length >= MAX_FULL_PAGE_SOURCE_LENGTH
      ) {
        return { text, map, overflow: true };
      }
      if (!isRenderedTextNode(node, styleCache)) continue;

      const block = nearestBlock(node, styleCache);
      const needsSeparator =
        text.length > 0 &&
        (block !== prevBlock ||
          hasLineBreakBetween(prevTextNode, node, root));
      const availableOutput =
        MAX_FULL_PAGE_SOURCE_LENGTH -
        text.length -
        (needsSeparator ? 1 : 0);
      if (availableOutput <= 0) {
        return { text, map, overflow: true };
      }

      const normalized = normalizeSliceBounded(
        node.data,
        MAX_FULL_PAGE_RAW_SOURCE_LENGTH - rawCharacters,
        availableOutput
      );
      rawCharacters += normalized.consumedRaw;
      if (normalized.out) {
        if (needsSeparator) text += "\n";
        const start = text.length;
        text += normalized.out;
        map.push({
          start,
          end: text.length,
          node,
          rawOffsets: normalized.rawOffsets,
          messageAnchor: makeWhatsAppMessageAnchor(node),
        });
        prevBlock = block;
        prevTextNode = node;
      }

      if (
        normalized.overflow ||
        map.length >= MAX_FULL_PAGE_MAP_ENTRIES ||
        rawCharacters >= MAX_FULL_PAGE_RAW_SOURCE_LENGTH ||
        text.length >= MAX_FULL_PAGE_SOURCE_LENGTH
      ) {
        return { text, map, overflow: true };
      }
    }
    return { text, map, overflow: false };
  }

  function normalizeSliceBounded(raw, maxRawCharacters, maxOutputCharacters) {
    let out = "";
    const rawOffsets = [];
    let inWs = false;
    let index = 0;
    const rawLimit = Math.min(
      raw.length,
      Math.max(0, Math.floor(maxRawCharacters))
    );
    const outputLimit = Math.max(0, Math.floor(maxOutputCharacters));

    while (index < rawLimit) {
      const first = raw.charCodeAt(index);
      const width =
        first >= 0xd800 &&
        first <= 0xdbff &&
        index + 1 < raw.length &&
        raw.charCodeAt(index + 1) >= 0xdc00 &&
        raw.charCodeAt(index + 1) <= 0xdfff
          ? 2
          : 1;
      if (index + width > rawLimit) break;

      const chunk = raw.slice(index, index + width);
      if (isWs(chunk)) {
        if (!inWs) {
          if (out.length + 1 > outputLimit) break;
          inWs = true;
          out += " ";
          rawOffsets.push(index);
        }
      } else {
        if (out.length + width > outputLimit) break;
        inWs = false;
        out += chunk;
        for (let offset = 0; offset < width; offset++) {
          rawOffsets.push(index + offset);
        }
      }
      index += width;
    }

    return {
      consumedRaw: index,
      out,
      overflow: index < raw.length,
      rawOffsets,
    };
  }

  function extractFromRoot(
    root,
    renderedOnly = false,
    maxCharacters = Infinity
  ) {
    const styleCache = new WeakMap();
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const accepted = renderedOnly
          ? isRenderedTextNode(node, styleCache)
          : isVisibleTextNode(node, styleCache);
        return accepted
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    const map = [];
    let text = "";
    let prevBlock = null;
    let prevTextNode = null;
    let node;
    while ((node = walker.nextNode())) {
      const { out, rawOffsets } = normalizeSlice(node.data, 0, node.data.length);
      if (!out) continue;
      const block = nearestBlock(node, styleCache);
      if (
        text.length > 0 &&
        (block !== prevBlock || hasLineBreakBetween(prevTextNode, node, root))
      ) {
        text += "\n";
      }
      prevBlock = block;
      prevTextNode = node;
      const start = text.length;
      text += out;
      if (text.length > maxCharacters) {
        return { text: "", map: [], overflow: true };
      }
      map.push({
        start,
        end: text.length,
        node,
        rawOffsets,
        messageAnchor: makeWhatsAppMessageAnchor(node),
      });
    }
    return { text, map, overflow: false };
  }

  // Collapse each run of whitespace to a single space, recording the source
  // raw offset for every emitted character so offsets round-trip exactly.
  function normalizeSlice(raw, from, to) {
    let out = "";
    const rawOffsets = [];
    let inWs = false;
    for (let i = from; i < to; i++) {
      const ch = raw[i];
      if (isWs(ch)) {
        if (inWs) continue;
        inWs = true;
        out += " ";
        rawOffsets.push(i);
      } else {
        inWs = false;
        out += ch;
        rawOffsets.push(i);
      }
    }
    return { out, rawOffsets };
  }

  function isWs(ch) {
    return !!ch && /\s/u.test(ch);
  }

  function isComparisonIgnorable(ch) {
    return !!ch && /[\u00ad\u200b-\u200d\u2060\ufeff]/u.test(ch);
  }

  function computedStyle(el, cache) {
    let style = cache && cache.get(el);
    if (!style) {
      style = window.getComputedStyle(el);
      if (cache) cache.set(el, style);
    }
    return style;
  }

  function isRenderedTextNode(node, cache) {
    let el = node.parentElement;
    if (!el) return false;
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return false;
    while (el) {
      if (el.hidden) return false;
      const cs = computedStyle(el, cache);
      if (cs.display === "none") return false;
      if (cs.visibility === "hidden" || cs.visibility === "collapse") {
        return false;
      }
      el = el.parentElement;
    }
    return true;
  }

  function isVisibleTextNode(node, cache) {
    if (!isRenderedTextNode(node, cache)) return false;
    let el = node.parentElement;
    let selectable = null;
    while (el) {
      const cs = computedStyle(el, cache);
      // `user-select` can be overridden below a non-selectable app shell.
      // WhatsApp does exactly that: the shell is `none`, while message text is
      // explicitly `text`. The closest decisive value controls whether this
      // node is selectable; distant ancestors must not override it. Visibility
      // has already been checked on every ancestor by isRenderedTextNode, so
      // the first decisive value ends this walk.
      if (cs.userSelect && cs.userSelect !== "auto") {
        selectable = cs.userSelect !== "none";
        break;
      }
      el = el.parentElement;
    }
    return selectable !== false;
  }

  function isRenderedElement(element) {
    if (!element?.isConnected) return false;
    for (let el = element; el; el = el.parentElement) {
      if (el.hidden) return false;
      const style = window.getComputedStyle(el);
      if (
        style.display === "none" ||
        style.visibility === "hidden" ||
        style.visibility === "collapse"
      ) {
        return false;
      }
    }
    return true;
  }

  const BLOCK_DISPLAYS = new Set([
    "block",
    "flex",
    "grid",
    "list-item",
    "table",
    "table-row",
    "table-cell",
    "table-caption",
    "flow-root",
  ]);

  function isBlockEl(el, cache) {
    if (!el) return false;
    const d = computedStyle(el, cache).display;
    return BLOCK_DISPLAYS.has(d);
  }

  function nearestBlock(node, cache) {
    let el = node.parentElement;
    while (el && !isBlockEl(el, cache)) el = el.parentElement;
    return el || node.parentElement;
  }

  function hasLineBreakBetween(previous, current, root) {
    if (!previous || !current) return false;
    let node = previous;
    // The text nodes are adjacent in the TreeWalker, so this normally visits
    // only a handful of intervening elements. The cap guards pathological DOM.
    for (let steps = 0; steps < 256; steps++) {
      node = nextDomNode(node, root);
      if (!node || node === current) return false;
      if (node.nodeType === Node.ELEMENT_NODE && node.tagName === "BR") {
        return true;
      }
    }
    return false;
  }

  function nextDomNode(node, root) {
    if (node.firstChild) return node.firstChild;
    while (node && node !== root) {
      if (node.nextSibling) return node.nextSibling;
      node = node.parentNode;
    }
    return null;
  }

  // --- Highlighting ---------------------------------------------------------

  function highlightRange(rawStart, rawEnd) {
    if (!extraction || !extraction.map.length) return false;
    const resolved = resolveLiveAttributionRange(rawStart, rawEnd);
    if (!resolved) return false;
    clearHighlight();
    applyHighlight(resolved.range);
    scrollRangeIntoView(resolved.range);
    return true;
  }

  function resolveLiveAttributionRange(rawStart, rawEnd) {
    if (!extraction || !extraction.map.length) return null;
    if (
      extraction.anchor?.routeKey &&
      extraction.anchor.routeKey !== currentRouteKey()
    ) {
      return null;
    }

    // The original map is the cheapest and strongest identity signal. Check
    // only the clicked attribution so unrelated hydration elsewhere in the
    // selected document cannot invalidate an unchanged target.
    if (extractionSpanIsCurrent(rawStart, rawEnd)) {
      return resolveRange(rawStart, rawEnd);
    }

    // If the complete selection is still present, rebasing it preserves the
    // server's original occurrence offsets even for repeated short phrases.
    if (
      refreshDetachedExtraction() &&
      extractionSpanIsCurrent(rawStart, rawEnd)
    ) {
      return resolveRange(rawStart, rawEnd);
    }

    // Otherwise resolve only the clicked quote within its original semantic
    // source. Context disambiguates repeats; missing or tied matches fail.
    return resolveSpanFromQuote(rawStart, rawEnd);
  }

  function mappedEntriesForSpan(rawStart, rawEnd) {
    const { start, end } = clampSpan(extraction.text, rawStart, rawEnd);
    if (end <= start) return null;
    const startEntry =
      findEntry(extraction.map, start) ||
      firstEntryAtOrAfter(extraction.map, start);
    const endEntry =
      findEntry(extraction.map, end - 1) ||
      lastEntryAtOrBefore(extraction.map, end - 1);
    if (!startEntry || !endEntry) return null;
    const first = extraction.map.indexOf(startEntry);
    const last = extraction.map.indexOf(endEntry);
    if (first < 0 || last < first) return null;
    return { start, end, first, last };
  }

  function extractionSpanIsCurrent(rawStart, rawEnd) {
    if (
      extraction.anchor?.routeKey &&
      extraction.anchor.routeKey !== currentRouteKey()
    ) {
      return false;
    }
    const scope = resolveAnchorScope(extraction.anchor);
    if (isStableAnchor(extraction.anchor) && !scope) return false;
    const target = mappedEntriesForSpan(rawStart, rawEnd);
    if (!target) return false;
    const styleCache = new WeakMap();
    for (let index = target.first; index <= target.last; index++) {
      if (
        !mapEntryIsCurrent(
          extraction.map[index],
          scope,
          styleCache,
          target.start,
          target.end
        )
      ) {
        return false;
      }
    }
    return true;
  }

  function resolveSpanFromQuote(rawStart, rawEnd) {
    const target = mappedEntriesForSpan(rawStart, rawEnd);
    if (!target) return null;
    const scope = recoveryScopeForSpan(target);
    if (!scope) return null;

    const capturedProjection = buildQuoteProjection(
      extraction.text,
      extraction.map
    );
    const selector = makeQuoteSelector(capturedProjection, target);
    if (!selector.exact) return null;

    const matched = matchQuoteWithin(scope, selector);
    if (!matched) return null;
    if (
      matched.evidence === "path" &&
      !rangeMatchesCapturedPath(matched.resolved.range, target, scope)
    ) {
      return null;
    }
    return matched.resolved;
  }

  // Project a live subtree exactly the way a captured extraction is projected,
  // then take the one occurrence the selector's bounded context supports.
  // Missing, ambiguous, and oversized sources all fail rather than guess.
  function matchQuoteWithin(scope, selector) {
    // Selectability is a capture concern, not a liveness requirement. Dynamic
    // apps may remove a temporary user-select override while the source remains
    // rendered and attributable.
    const rebuilt = extractFromRoot(
      scope,
      true,
      MAX_QUOTE_SOURCE_LENGTH
    );
    if (rebuilt.overflow) return null;
    const liveProjection = buildQuoteProjection(rebuilt.text, rebuilt.map);
    const match = chooseQuoteMatch(liveProjection.text, selector);
    if (!match) return null;

    const canonicalStart = liveProjection.canonicalOffsets[match.index];
    const canonicalEnd =
      liveProjection.canonicalOffsets[
        match.index + selector.exact.length - 1
      ] + 1;
    if (
      !Number.isFinite(canonicalStart) ||
      !Number.isFinite(canonicalEnd)
    ) {
      return null;
    }
    const resolved = resolveRangeFromMap(
      rebuilt.map,
      canonicalStart,
      canonicalEnd
    );
    return resolved ? { resolved, evidence: match.evidence } : null;
  }

  // Recover one attributed span in a document this frame never captured: the
  // page reloaded after the answer was attributed, so the node map is gone and
  // the cached document no longer matches the page character for character.
  // The cached document still records the exact quote and the text around it,
  // which is all the shared quote resolver needs.
  function highlightDocumentQuote(documentText, rawStart, rawEnd) {
    const resolved = resolveDocumentQuoteRange(documentText, rawStart, rawEnd);
    if (!resolved) return false;
    clearHighlight();
    applyHighlight(resolved.range);
    scrollRangeIntoView(resolved.range);
    return true;
  }

  function resolveDocumentQuoteRange(documentText, rawStart, rawEnd) {
    if (!document.body) return null;
    const selector = makeDocumentQuoteSelector(documentText, rawStart, rawEnd);
    if (!selector) return null;
    const matched = matchQuoteWithin(document.body, selector);
    // A reloaded page keeps no saved path to corroborate a lone match, so
    // being the page's only occurrence is the identity — the same rule that
    // rebases a unique captured selection onto fresh nodes. Repeats still have
    // to be singled out by the cached context, and ties still fail.
    return matched ? matched.resolved : null;
  }

  // The cached document is mapped node text plus synthetic block separators,
  // so projecting it under one whole-text entry produces exactly the string a
  // live extraction of the same nodes projects.
  function makeDocumentQuoteSelector(documentText, rawStart, rawEnd) {
    const text = String(documentText || "");
    const { start, end } = clampSpan(text, rawStart, rawEnd);
    if (end <= start) return null;
    const projection = buildQuoteProjection(text, [
      { start: 0, end: text.length },
    ]);
    const exact = projectedSlice(projection, start, end).trim();
    if (!exact) return null;
    const contexts = [];
    addQuoteContext(
      contexts,
      projectedSlice(projection, 0, start).slice(-QUOTE_CONTEXT_LENGTH),
      projectedSlice(projection, end, text.length).slice(
        0,
        QUOTE_CONTEXT_LENGTH
      )
    );
    return { exact, contexts };
  }

  function recoveryScopeForSpan(target) {
    const entries = extraction.map.slice(target.first, target.last + 1);
    const messageAnchors = entries
      .map((entry) => entry.messageAnchor)
      .filter(Boolean);
    if (messageAnchors.length) {
      // A reused conversation root is not a message identity. Recover only
      // when every target entry belongs to one exact serialized message.
      if (messageAnchors.length !== entries.length) return null;
      const ids = new Set(messageAnchors.map((anchor) => anchor.dataId));
      if (ids.size !== 1) return null;
      return resolveWhatsAppMessageScope(messageAnchors[0]);
    }
    if (location.hostname === "web.whatsapp.com") return null;

    const anchored = resolveAnchorScope(extraction.anchor);
    if (isStableAnchor(extraction.anchor)) return anchored;
    return anchored || document.body;
  }

  function buildQuoteProjection(text, map) {
    let projected = "";
    const canonicalOffsets = [];
    let inWhitespace = false;
    let mapIndex = 0;

    for (let index = 0; index < text.length; index++) {
      while (mapIndex < map.length && map[mapIndex].end <= index) mapIndex++;
      const mapped =
        mapIndex < map.length &&
        map[mapIndex].start <= index &&
        index < map[mapIndex].end;
      const ch = text[index];
      if (isWs(ch)) {
        if (inWhitespace) continue;
        inWhitespace = true;
        projected += " ";
        canonicalOffsets.push(index);
        continue;
      }
      // Synthetic block separators are whitespace. Any other unmapped
      // character is not backed by a live DOM position and is ignored.
      if (!mapped) continue;
      inWhitespace = false;
      projected += ch;
      canonicalOffsets.push(index);
    }
    return { text: projected, canonicalOffsets };
  }

  function makeQuoteSelector(projection, target) {
    const startEntry = extraction.map[target.first];
    const endEntry = extraction.map[target.last];
    const exact = projectedSlice(
      projection,
      target.start,
      target.end
    ).trim();
    // Prefer context inside the boundary Text nodes so a paragraph can move
    // without being tied to its old neighbor. Selection-wide context provides
    // evidence when the quote consumes an entire boundary node.
    const localPrefix = projectedSlice(
      projection,
      startEntry.start,
      target.start
    ).slice(-QUOTE_CONTEXT_LENGTH);
    const localSuffix = projectedSlice(
      projection,
      target.end,
      endEntry.end
    ).slice(0, QUOTE_CONTEXT_LENGTH);
    const selectionPrefix = projectedSlice(
      projection,
      0,
      target.start
    ).slice(-QUOTE_CONTEXT_LENGTH);
    const selectionSuffix = projectedSlice(
      projection,
      target.end,
      extraction.text.length
    ).slice(0, QUOTE_CONTEXT_LENGTH);
    const scopedPrefix = (
      (startEntry.scopePrefix || "") + localPrefix
    ).slice(-QUOTE_CONTEXT_LENGTH);
    const scopedSuffix = (
      localSuffix + (endEntry.scopeSuffix || "")
    ).slice(0, QUOTE_CONTEXT_LENGTH);
    const blockPrefix = (
      (startEntry.blockPrefix || "") + localPrefix
    ).slice(-QUOTE_CONTEXT_LENGTH);
    const blockSuffix = (
      localSuffix + (endEntry.blockSuffix || "")
    ).slice(0, QUOTE_CONTEXT_LENGTH);
    const contexts = [];
    addQuoteContext(contexts, localPrefix, localSuffix);
    addQuoteContext(contexts, blockPrefix, blockSuffix);
    addQuoteContext(contexts, scopedPrefix, scopedSuffix);
    addQuoteContext(contexts, selectionPrefix, selectionSuffix);
    return { exact, contexts };
  }

  function addQuoteContext(contexts, prefix, suffix) {
    if (!prefix && !suffix) return;
    if (
      contexts.some(
        (context) =>
          context.prefix === prefix && context.suffix === suffix
      )
    ) {
      return;
    }
    contexts.push({ prefix, suffix });
  }

  function projectedSlice(projection, canonicalStart, canonicalEnd) {
    let value = "";
    for (let index = 0; index < projection.text.length; index++) {
      const offset = projection.canonicalOffsets[index];
      if (offset < canonicalStart) continue;
      if (offset >= canonicalEnd) break;
      value += projection.text[index];
    }
    return value;
  }

  function chooseQuoteMatch(text, selector) {
    const matches = [];
    let cursor = 0;
    while (cursor <= text.length - selector.exact.length) {
      const match = text.indexOf(selector.exact, cursor);
      if (match < 0) break;
      matches.push(match);
      if (matches.length > MAX_QUOTE_MATCHES) return null;
      cursor = match + 1;
    }
    if (!matches.length) return null;

    const supported = new Set();
    for (const context of selector.contexts) {
      const contextual = matches.filter((match) =>
        quoteContextMatches(text, selector.exact, match, context)
      );
      if (contextual.length === 1) supported.add(contextual[0]);
    }
    if (supported.size === 1) {
      return { index: [...supported][0], evidence: "context" };
    }
    // A lone exact quote is only tentative: it still has to occupy the saved
    // path and raw offsets. Otherwise a mutated original could redirect to a
    // surviving duplicate elsewhere in the same source.
    return matches.length === 1
      ? { index: matches[0], evidence: "path" }
      : null;
  }

  function quoteContextMatches(text, exact, match, context) {
    const prefixMatches =
      !context.prefix ||
      text.slice(match - context.prefix.length, match) === context.prefix;
    const suffixMatches =
      !context.suffix ||
      text.slice(
        match + exact.length,
        match + exact.length + context.suffix.length
      ) === context.suffix;
    return prefixMatches && suffixMatches;
  }

  function rangeMatchesCapturedPath(range, target, scope) {
    const startEntry = extraction.map[target.first];
    const endEntry = extraction.map[target.last];
    const startPath =
      startEntry.messageAnchor?.path || startEntry.anchorPath;
    const endPath = endEntry.messageAnchor?.path || endEntry.anchorPath;
    if (!Array.isArray(startPath) || !Array.isArray(endPath)) return false;

    const startNode = nodeAtPath(scope, startPath);
    const endNode = nodeAtPath(scope, endPath);
    const startIndex = Math.max(target.start, startEntry.start);
    const endIndex = Math.min(target.end - 1, endEntry.end - 1);
    const startOffset =
      startEntry.rawOffsets[startIndex - startEntry.start];
    const endOffset =
      endEntry.rawOffsets[endIndex - endEntry.start] + 1;
    return (
      startNode === range.startContainer &&
      endNode === range.endContainer &&
      startOffset === range.startOffset &&
      endOffset === range.endOffset
    );
  }

  function mapEntryIsCurrent(
    entry,
    scope,
    styleCache,
    spanStart = entry.start,
    spanEnd = entry.end
  ) {
    return mapEntryMatchesNode(
      entry,
      entry.node,
      scope,
      styleCache,
      spanStart,
      spanEnd
    );
  }

  function mapEntryMatchesNode(
    entry,
    node,
    scope,
    styleCache,
    spanStart = entry.start,
    spanEnd = entry.end
  ) {
    const messageScope = entry.messageAnchor
      ? resolveWhatsAppMessageScope(entry.messageAnchor)
      : null;
    if (
      !node?.isConnected ||
      (scope && !scope.contains(node)) ||
      (entry.messageAnchor &&
        (!messageScope || !messageScope.contains(node))) ||
      !isRenderedTextNode(node, styleCache)
    ) {
      return false;
    }
    const start = Math.max(entry.start, spanStart);
    const end = Math.min(entry.end, spanEnd);
    if (end <= start) return false;
    let actual = "";
    for (let index = start; index < end; index++) {
      const rawOffset = entry.rawOffsets[index - entry.start];
      const ch = node.data[rawOffset];
      if (ch == null) return false;
      actual += isWs(ch) ? " " : ch;
    }
    return actual === extraction.text.slice(start, end);
  }

  function resolveRange(rawStart, rawEnd) {
    if (!extraction || !extraction.map.length) return null;
    const { start, end } = clampSpan(extraction.text, rawStart, rawEnd);
    if (end <= start) return null;
    return resolveRangeFromMap(extraction.map, start, end);
  }

  function resolveRangeFromMap(map, start, end) {
    // The extraction string contains synthetic "\n" block separators that have
    // no map entry. Clamp ends onto real mapped characters.
    const startEntry = findEntry(map, start) || firstEntryAtOrAfter(map, start);
    const endEntry = findEntry(map, end - 1) || lastEntryAtOrBefore(map, end - 1);
    if (!startEntry || !endEntry) return null;

    const sIdx = Math.max(start, startEntry.start);
    const eIdx = Math.min(end - 1, endEntry.end - 1);
    if (
      eIdx < sIdx ||
      !startEntry.node.isConnected ||
      !endEntry.node.isConnected
    ) {
      return null;
    }

    const nodeStart = startEntry.rawOffsets[sIdx - startEntry.start];
    const nodeEnd = endEntry.rawOffsets[eIdx - endEntry.start] + 1;
    if (!Number.isFinite(nodeStart) || !Number.isFinite(nodeEnd)) return null;

    try {
      const range = document.createRange();
      range.setStart(startEntry.node, nodeStart);
      range.setEnd(endEntry.node, nodeEnd);
      return { range, startEntry, endEntry };
    } catch (e) {
      // Do not fall back to a naked text search: it silently selects the first
      // duplicate occurrence. A failed exact remap is safer than a false cite.
      return null;
    }
  }

  // Highlight exactly the span TokenPath resolved — it already snaps to word
  // boundaries and verbatim source occurrences server-side, so any client-side
  // expansion (e.g. to sentence bounds) would only blur the precision that
  // token-level attribution buys. Just clamp into range and keep the ends off
  // whitespace / the synthetic "\n" block separators.
  function clampSpan(text, start, end) {
    const n = text.length;
    const rawStart = Number(start);
    const rawEnd = Number(end);
    if (!Number.isFinite(rawStart) || !Number.isFinite(rawEnd)) {
      return { start: 0, end: 0 };
    }
    let s = Math.max(0, Math.min(Math.trunc(rawStart), n));
    let e = Math.max(s, Math.min(Math.trunc(rawEnd), n));

    while (s < e && isWs(text[s])) s++;
    while (e > s && isWs(text[e - 1])) e--;

    return { start: s, end: e };
  }

  // Binary search: entry with start <= offset < end.
  function findEntry(map, offset) {
    let lo = 0;
    let hi = map.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const e = map[mid];
      if (offset < e.start) hi = mid - 1;
      else if (offset >= e.end) lo = mid + 1;
      else return e;
    }
    return null;
  }

  // First entry whose text reaches at or past `offset` (for clamping a range
  // start that landed in a synthetic separator gap).
  function firstEntryAtOrAfter(map, offset) {
    for (let i = 0; i < map.length; i++) if (map[i].end > offset) return map[i];
    return null;
  }

  // Last entry whose text starts at or before `offset`.
  function lastEntryAtOrBefore(map, offset) {
    for (let i = map.length - 1; i >= 0; i--) {
      if (map[i].start <= offset) return map[i];
    }
    return null;
  }

  function applyHighlight(range) {
    if (!("highlights" in CSS)) {
      // Extremely old Chrome — fall back to native selection.
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return;
    }
    highlight = new Highlight(range);
    // Two static rulesets in content.css; choosing between them by name keeps
    // every colour value in the stylesheet and never lets page-controlled
    // text reach CSS.
    CSS.highlights.set(
      hasDarkBackdrop(range) ? HL_NAME_DARK : HL_NAME,
      highlight
    );
  }

  function clearHighlight() {
    activeHighlightId = null;
    removeSeekIndicator();
    if (!("highlights" in CSS)) {
      const selection = window.getSelection();
      if (selection) selection.removeAllRanges();
      return;
    }
    if (highlight) {
      highlight.clear();
      highlight = null;
    }
    CSS.highlights.delete(HL_NAME);
    CSS.highlights.delete(HL_NAME_DARK);
  }

  // Gmail's dark theme and X paint their own backgrounds rather than switching
  // the page's colour scheme, so ask the DOM what is actually behind the
  // attributed text: the nearest effectively opaque background above it, then
  // the document canvas.
  function hasDarkBackdrop(range) {
    try {
      const start = range.startContainer;
      const from =
        start.nodeType === Node.ELEMENT_NODE ? start : start.parentElement;
      for (let el = from; el; el = el.parentElement) {
        const color = parseCssColor(
          window.getComputedStyle(el).backgroundColor
        );
        if (color && color.alpha >= 0.5) {
          return relativeLuminance(color) < DARK_BACKDROP_LUMINANCE;
        }
      }
      for (const fallback of [document.body, document.documentElement]) {
        if (!fallback) continue;
        const color = parseCssColor(
          window.getComputedStyle(fallback).backgroundColor
        );
        if (color && color.alpha >= 0.5) {
          return relativeLuminance(color) < DARK_BACKDROP_LUMINANCE;
        }
      }
    } catch (e) {
      // An unusual document implementation must never block a highlight.
    }
    return false;
  }

  function parseCssColor(value) {
    const match = /^rgba?\(([^)]+)\)$/i.exec(String(value || "").trim());
    if (!match) return null;
    const parts = match[1]
      .split(/[\s,/]+/)
      .filter(Boolean)
      .map(Number);
    if (parts.length < 3 || parts.slice(0, 3).some((n) => !Number.isFinite(n))) {
      return null;
    }
    const alpha = Number.isFinite(parts[3]) ? parts[3] : 1;
    return { r: parts[0], g: parts[1], b: parts[2], alpha };
  }

  function relativeLuminance({ r, g, b }) {
    const channel = (value) => {
      const scaled = Math.min(255, Math.max(0, value)) / 255;
      return scaled <= 0.03928
        ? scaled / 12.92
        : Math.pow((scaled + 0.055) / 1.055, 2.4);
    };
    return (
      0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b)
    );
  }

  // Center the exact Range through nested scroll panes. Gmail's nearest text
  // parent is often the full-height message body, so element.scrollIntoView()
  // can report success while leaving the attributed line off-screen.
  function scrollRangeIntoView(range) {
    const reduced = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    const behavior = reduced ? "auto" : "smooth";
    let element =
      range.startContainer.nodeType === Node.ELEMENT_NODE
        ? range.startContainer
        : range.startContainer.parentElement;
    const initialRect = range.getBoundingClientRect();
    if (!element || (!initialRect.width && !initialRect.height)) {
      element?.scrollIntoView({ behavior, block: "center", inline: "nearest" });
      return;
    }

    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = window.getComputedStyle(parent);
      const scrollable =
        /(auto|scroll|overlay)/.test(style.overflowY) &&
        parent.scrollHeight > parent.clientHeight + 1;
      if (!scrollable) continue;
      const rect = range.getBoundingClientRect();
      const box = parent.getBoundingClientRect();
      if (rect.top < box.top || rect.bottom > box.bottom) {
        parent.scrollBy?.({
          top: rect.top - box.top - box.height / 2 + rect.height / 2,
          // Apply inner scrolls immediately so geometry for outer Gmail panes
          // is measured after the inner pane has moved.
          behavior: "auto",
        });
      }
    }

    const rect = range.getBoundingClientRect();
    // Leave room for sticky application chrome (notably X's top navigation)
    // instead of considering a technically on-screen but covered line visible.
    const topSafeArea = Math.min(96, Math.max(24, window.innerHeight * 0.08));
    if (rect.top < topSafeArea || rect.bottom > window.innerHeight) {
      window.scrollBy({
        top:
          rect.top -
          (window.innerHeight + topSafeArea) / 2 +
          rect.height / 2,
        behavior,
      });
    }
  }

  // --- Test hooks -----------------------------------------------------------

  // Unit tests evaluate this exact file and exercise the pure offset helpers
  // through this object, so their behaviour can never drift from the page's.
  // A real page never defines `__tokenpathTestHooks`, so nothing is exported
  // and no runtime behaviour changes; the harness must create the object first.
  if (
    globalThis.__tokenpathTestHooks &&
    typeof globalThis.__tokenpathTestHooks === "object"
  ) {
    Object.assign(globalThis.__tokenpathTestHooks, {
      buildQuoteProjection,
      buildTranscriptFromSegments,
      chooseQuoteMatch,
      clampSpan,
      findCueForSpan,
      findEntry,
      firstEntryAtOrAfter,
      hasDarkBackdrop,
      isWs,
      lastEntryAtOrBefore,
      hasCaptionTracks,
      makeDocumentQuoteSelector,
      normalizeSlice,
      normalizedYouTubeSearch,
      playerResponseFrom,
      resolveRangeFromMap,
      seekStartMsForSpan,
      timestampToMs,
      transcriptPanelParams,
      transcriptSegmentsFrom,
    });
  }
})();
