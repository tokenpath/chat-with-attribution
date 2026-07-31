# Spec: TokenPath — Chat with Attribution

## Goal

TokenPath — Chat with Attribution is a Chrome Manifest V3 extension. A user
clicks the toolbar icon for a one-click summary of the whole page, or selects
text, right-clicks, and chooses the single **Chat with TokenPath** context-menu
item. A selection uses only that span. A context-menu click without a selection uses the rendered text
of the originating page/frame or the entire top-level searchable PDF. The
resulting side-panel chat is grounded in that source text. TokenPath streams
each answer, then returns one answer-to-document heatmap. Clicking an attributed
phrase, choosing one from the answer's **Sources** list, or selecting any part
of an answer resolves that range against the cached heatmap, highlights its
supporting source range, and scrolls there in the live page or PDF.

## User flow

1. Enter through the toolbar icon or through **Chat with TokenPath** on a page,
   nested frame, or searchable PDF. The context menu is one item in the
   selection, page, and frame contexts; a selection takes precedence, and
   without one the originating HTML frame or top-level PDF becomes the source.
   The toolbar icon always captures the complete active page (or PDF, or
   video transcript) and asks for a summary of it (see step 3).
2. The panel confirms capture immediately in a compact source row,
   independently of API-key validation or credit refresh. The full captured
   text is collapsed by default and can be expanded on demand.
3. Only a toolbar capture starts a turn, and only when there is nothing to
   show: a page whose chat was saved earlier reopens that conversation and
   spends nothing. Every other capture waits. The empty chat offers one
   **Summarize** starter, which runs the summary pathway
   (`controller.runSummary()`) against the live context, or — when the panel
   has no context yet — submits a plain summary question that captures the
   page first. Sources at or below the concise-source cutoff show an “Already
   concise” note instead of generating, and the starter is suppressed while
   that note shows.
4. Continue with follow-up questions in the same composer and attributed chat.
   The composer stays usable while an answer streams; its submit button becomes
   **Stop**, which cancels the request and keeps the partial answer marked
   incomplete.
5. Click an attributed phrase, open the answer's **Sources (n)** list, or select
   any text in a completed answer to highlight and center its supporting source
   text in the originating page frame or PDF.

## Components

- **`manifest.json`** injects `content.js` and `content.css` at
  `document_start` with `all_frames`, `match_about_blank`, and
  `match_origin_as_fallback` enabled. Its `host_permissions` keep `<all_urls>`
  alongside the TokenPath API origins — in the store package too — because the
  panel reads `tab.url` outside a user gesture (chat restore, navigation
  invalidation, stale-seed checks) and downloads full PDFs from the panel;
  `scripts/package-extension.mjs` documents the policy and strips only the
  staging and localhost development origins.
- **`background.js`** owns the single **Chat with TokenPath** context-menu item
  (and removes the legacy submenu items on startup); handles the toolbar action;
  starts the side-panel open; captures from `info.frameId`; detects native PDFs;
  stores and broadcasts a versioned selection seed; serves the panel's
  `capture-tab-for-chat` request; and owns PDF text-fragment navigation/reload.
- **`content.js`** snapshots selections, creates the canonical text-to-DOM map,
  extracts full rendered pages when requested, resolves document offsets,
  repairs mappings after supported DOM rerenders, renders the source highlight,
  and scrolls nested panes.
- **`src/sidepanel/controller.ts`** manages auth, chat history, summary policy,
  full-PDF extraction, capture/version epochs, cancellation, page-chat
  persistence, and frame-targeted highlight messages.
- **`src/sidepanel/chat-cache.ts`** owns the IndexedDB page-chat store: the
  fragment-free cache key, document identity comparison, bounded retention, and
  the shingle-based “page changed significantly” test.
- **`src/sidepanel/pdf-text-extractor.ts`** fetches a verified PDF and uses a
  hidden Blob-backed instance of Chrome's native viewer to obtain PDFium's
  searchable text.
- **`src/sidepanel/app.tsx`** is a thin shell: it wires the controller snapshot
  to the panel components, owns the empty-state **Summarize** starter, and
  renders the dismissible notice and announcement regions.
- **`src/sidepanel/components/panel/`** holds those components — `panel-header`
  (theme, credits, clear highlight, clear chat), `auth-panel`, `source-card`,
  `composer`, `answer-response` (attributed
  phrases, the **Sources** list, incomplete/unavailable states), `chat-message`,
  and `error-boundary`.
- **`src/sidepanel/lib/answer-highlights.ts`** and
  **`src/sidepanel/hooks/use-answer-highlights.ts`** own the panel-side CSS
  custom highlights over attributable and hovered answer phrases;
  **`src/sidepanel/lib/source-copy.ts`** derives every user-facing source string
  from structured snapshot fields.
- **`src/sidepanel/answer-selection.ts`** maps a DOM selection inside rendered
  Streamdown Markdown back to the exact raw-answer character bounds.
- **`src/sidepanel/components/ai-elements/`** contains the trimmed, editable AI
  Elements source used by the Chrome side panel.
- **`sidepanel/panel.js`** and **`sidepanel/panel.css`** are generated,
  self-contained Vite assets loaded by the MV3 extension page.
- **`sidepanel/panel-logic.js`** contains pure summary, Unicode-safe truncation,
  and heatmap-to-source span-resolution helpers.
- **`sidepanel/tokenpath.js`** calls TokenPath directly with the API key in
  `chrome.storage.local`, streams messages-only generation, validates sparse
  heatmaps, and adapts their offset tables for browser use. It also enforces the
  base-URL allowlist: only `https://api.tokenpath.ai`,
  `https://api-staging.tokenpath.ai`, `http://localhost:8000`, and
  `http://127.0.0.1:8000` (bare origins, trailing slash tolerated) are accepted;
  anything else logs one warning and falls back to production.

## Selection capture and panel bootstrap

The context-menu callback supplies flattened `selectionText` but not DOM nodes.
One item, **Chat with TokenPath**, is registered across the selection, page, and
frame contexts; the worker removes the earlier submenu's item IDs on startup, so
an unpacked reload cannot leave stale actions behind. Each frame listens for
selection changes, clones the current `Range`, and eagerly extracts it during
`contextmenu`.

The toolbar action is the second entry point, and the one-click TLDR path.
`openPanelOnActionClick` is disabled so the worker owns the click: it runs the
same `captureAndOpen` as the context menu with `frameId: 0`, `forceFullPage`,
and `intent: "tldr"`, so the capture starts before the panel finishes opening.
The panel restores this page's cached chat if there is one — a saved
conversation is the answer to "TLDR this page", so it cancels the pending
summary and spends nothing — and otherwise summarizes what it just captured.

A panel opened without a capture still defers: the first question (or the
**Summarize** starter with no context) sends `capture-tab-for-chat`, which runs
the same full-page capture path against frame 0 with `intent: "ask"` and
without reopening the panel.

`chrome.sidePanel.open()` must begin synchronously in the click gesture, but the
background worker does not await it. It first starts an idempotent script and CSS
injection into the originating `frameId`, covering tabs that predate an unpacked
extension reload, then immediately sends `capture-selection`. Missing receivers
and content-level capture failures are retried once after injection completes.
This ordering keeps the panel animation and credit lookup off the capture path.

When `selectionText` is empty on ordinary HTML, the worker instead sends
`capture-page` to that same `frameId`. The content script walks rendered text
beneath the frame's `document.body`, including visible `user-select: none`
content while excluding hidden/script/style nodes. It stores the same private
text-to-DOM map used by selection capture, returns at most a surrogate-safe
400,000-character prefix, and marks a truncated seed. Raw text work and map
entries have independent safety budgets, so pathological DOMs can stop earlier.
It never reuses a prior stored Range or concatenates descendant frames.

An eagerly extracted DOM `Range` is authoritative. Chrome's flattened
`selectionText` is only a recovery hint when late injection missed the
`contextmenu` event. Hint recovery:

- removes invisible formatting characters and collapses Unicode whitespace;
- applies length-preserving ASCII case folding for CSS `text-transform`;
- follows the closest decisive `user-select` value, omitting `none` controls
  while honoring nearer `text` or `all` overrides; and
- accepts only a unique occurrence.

These rules cover current Substack, WhatsApp, and X selection shapes without
silently choosing the wrong duplicate.

Every seed carries `captureId`, `capturedAt` (the click), `seededAt` (the
session-storage write), `tabId`, `windowId`, `frameId`, `captureMode`,
`intent`, `sourceType`, and the source URL. `intent` is why the click happened:
only the toolbar's `"tldr"` asks the panel to summarize by itself, and every
context-menu capture is an `"ask"` that waits. IDs are allocated before extraction, so click
order—not async completion order—defines freshness. The panel installs its live
listener before active-tab lookup, seed replay, or credit validation. A replayed
seed is discarded when its capture is more than 120 seconds old or when its URL
is a different document from the live tab's, so a panel opened long after the
click cannot adopt a document the tab has left. Duplicate and stale seeds cannot
replace a newer capture or change its highlight route.

Chrome's built-in PDF viewer is a protected component extension, so ordinary
content scripts cannot read its DOM or receive highlight messages. For every
PDF context-menu click, the worker probes the top-level document's MIME type and
marks the seed `sourceType: "chrome-pdf"` while retaining the original PDF URL.
With a selection, `OnClickData.selectionText` is the canonical document. With
no selection, the seed uses `captureMode: "full-pdf"` and contains only a small
descriptor. The side panel fetches that URL with the extension's `<all_urls>`
host permission — a credentialed cross-origin fetch from an extension page,
which `activeTab` does not cover — verifies and bounds the bytes, then creates an
offscreen, nonzero-size `<embed>` backed by a same-origin Blob URL. Chrome's
native PDF scripting bridge selects all inside this hidden duplicate and
returns PDFium's searchable text. The panel removes the embed and revokes the
Blob URL immediately, so the visible viewer's selection and viewport do not
change.

Only a `documentLoaded` message from Chrome's exact built-in PDF-viewer origin
establishes the hidden viewer's `WindowProxy`; the selected-text reply must come
from that same source. Extraction jobs are serialized, time-bounded, abort when
a newer capture or navigation wins, reject non-PDF responses and downloads over
50 MiB, and return at most 400,000 Unicode code points. Full extracted text stays
in panel memory rather than `chrome.storage.session`; the small descriptor can
be replayed if the panel reopens. Empty searchable text produces an explicit
scan/image-only error.

This keeps normal page capture strict: flattened context-menu text is not
promoted to an authoritative source unless the tab is verified as a PDF. A
no-selection HTML click creates a fresh full-page map instead of reusing an old
page selection.

Successful captures keep the source excerpt collapsed so the answer owns the
panel's vertical space. The row remains keyboard-expandable for inspection and
recollapses when the captured text changes. Waiting, empty-capture, and capture
error messages remain visible without requiring expansion.

## Canonical extraction and node map

The content script walks visible text nodes intersecting the stored range. It
collapses whitespace per text node, inserts `\n` at block or `<br>` boundaries,
and records every emitted character's raw node offset:

```js
{ start, end, node, rawOffsets }
```

`start` and `end` index the canonical extraction string in JavaScript UTF-16
code units. The node map never crosses the extension-message boundary. The exact
canonical string is sent as TokenPath's `document` and is not normalized again.
TokenPath returns heatmap token offsets as Unicode code-point bounds. The API
adapter converts the full answer and document offset tables against their exact
strings before the panel aggregates a selected answer range or the content
script resolves a DOM range. This prevents cumulative highlight drift after
emoji while preserving repeated-string disambiguation.

## Summary and generation policy

The summary pathway is reached from the **Summarize** starter and from a
toolbar capture, which requests it automatically. That request is held on the
controller with the `contextVersion` it was made under and runs once, only when
the panel is connected, idle, and still on that exact context; a tab switch,
navigation, capture failure, or restored chat drops it. A disconnected panel
keeps it pending and spends nothing until `connect()` succeeds. Captured
sources of 24 whitespace-delimited words or fewer skip
the model call and post an “Already concise” note naming the source kind
(selection, page, or PDF); the starter is hidden while such a note is present.
CJK-dominant sources are measured by characters (48) rather than whitespace
tokens, so multi-paragraph CJK prose is not mistaken for a one-word selection.

Longer sources all get the same request. `buildSummaryRequest` takes only the
captured text and returns one prompt and one ceiling; there is no length
preference, no persisted setting, and no per-source tier:

- The prompt asks for exactly 3 concise Markdown bullet points, most important
  takeaway first, one sentence each, covering only what someone needs to
  understand the source quickly. "Exactly 3" rather than a range: a range makes
  models drift to its upper bound and makes the 360px panel's height jump
  between summaries. The suffix forbids a title, a `TL;DR:` label, a preamble,
  an explanation, or a closing comment, and asks the model to finish cleanly.
- The ceiling is 2048 output tokens — TokenPath's own `max_output_tokens`
  maximum — for every generation path: summaries and ordinary chat turns,
  page, PDF, selection, and video transcript alike. Generation is billed from
  the input text, so a lower ceiling saves nothing and only risks stopping an
  answer mid-sentence.

The ceiling is headroom, not a target length; the prompt controls concision
without cutting off a sentence. An answer that produces every token it was
allowed is treated as cut short and gets a note saying it reached the maximum
answer length and suggesting a narrower question or asking for the rest. That
answer is still a normal, attributed answer — every word is text the model
wrote — unlike the aborted and mid-stream-failure paths, which keep their
partial text but are deliberately left unattributed. The terminal `done.answer`
is preserved unchanged for display, history, and attribution. There is no
client-side clipping or extractive fallback. Document and conversation limits
are counted by Unicode code point so truncation does not split surrogate pairs.

## Streaming generation and just-in-time heatmap attribution

Only a toolbar capture starts a turn, and only when it has no saved chat to
show instead. A context-menu capture's source may be inspected in the panel,
but no generation or attribution request is made until the user submits the
composer or runs the **Summarize** starter. Once a turn starts, the generator
uses one
streaming `POST /v1/generate` request. Its body contains only messages and an
optional `max_output_tokens`:

- a system message containing the website origin, exact canonical document,
  and conditional Markdown formatting instructions;
- bounded prior user and assistant turns; and
- the latest user question.

TokenPath chooses the model. Named SSE `delta` events update one stable
assistant message; the terminal `done.answer` is canonical and may replace the
locally accumulated deltas. Navigation, a newer capture, or disconnect cancels
active generation and discards its turn. The exact terminal answer is added to
history and sent to attribution without client-side rewriting.

Two cancellations are deliberately *not* invalidations. The composer's **Stop**
button aborts the request while keeping the question and whatever text had
streamed, flagged `incomplete`; a mid-stream network failure keeps the same
partial answer and reports the failure as a note beside it. Neither attributes
the partial text — a heatmap over an unfinished answer would map words the model
never wrote — so both leave the answer with no source map. An empty partial
answer is removed instead of being kept.

Once generation finishes, the panel sends one
`POST /v1/attributions/heatmap` request:

```js
{
  document: "the canonical extracted source",
  question: "the latest user turn",
  answer: "the exact final displayed answer"
}
```

The response is a sparse COO matrix:

```js
{
  row: [0, 0, 1],
  col: [4, 5, 7],
  data: [0.8, 0.3, 0.6],
  shape: [answerTokenCount, documentTokenCount],
  answer_offsets: [[0, 4], [5, 9]],
  document_offsets: [[0, 3], [4, 8]]
}
```

`sidepanel/tokenpath.js` validates matching COO lengths and matrix bounds, then
converts both offset tables from Unicode code points to UTF-16. The immutable
artifact `{document, question, answer, heatmap}` belongs to that assistant
message. An attribution failure marks only its source map unavailable; the
generated answer remains usable. Capture and generation epochs prevent a late
heatmap from attaching to newer state.

Streamdown always renders the answer as Markdown. `answer-selection.ts` parses
the same GFM into source-positioned visible leaves, excluding hidden link
destinations and image metadata while decoding entities and escapes. It aligns
Streamdown's text nodes to that visible map, so a user selection recovers exact
raw-answer bounds across emphasis, selectable links, inline or fenced code,
blocks, repeated phrases, and Unicode. Collapsed, empty, or out-of-answer
selections are ignored.

The local resolver mirrors TokenPath's service-side span policy:

1. Find every answer token overlapping the selected raw-answer range.
2. Sum its positive sparse attribution mass per document token.
3. Start at the peak and grow across tokens at or above 25% of that peak,
   bridging at most three weaker tokens.
4. Convert the resolved token interval to document character bounds and snap
   outward across adjacent alphanumeric characters.
5. If the selected answer text occurs verbatim in the document, snap only to an
   occurrence that overlaps the attention-derived interval, choosing the
   nearest center when needed.

The resolved range and confidence are computed entirely in the panel. Repeated
answer selections reuse the same cached heatmap and make no more attribution
requests. Streamdown's sanitizer and external-link confirmation remain active,
remote images are suppressed, and rendered links are limited to HTTP(S) and
mail links.

A ready answer also exposes its attributed phrases directly. `panel-logic.js`
derives them from the same cached heatmap; the panel maps each one to a `Range`
in the rendered Markdown and paints them with two document-scoped CSS custom
highlights (all attributable phrases, plus the one under the pointer or
keyboard). Clicking a phrase runs the same resolution path as selecting its
text. The **Sources (n)** toggle beside the answer lists those phrases as a
`toolbar` with roving focus: arrow keys and Home/End move, Enter activates the
focused phrase, and Escape closes the list and returns focus to the toggle. This
is the keyboard-reachable equivalent of clicking, not a second attribution
mechanism.

The panel owns the currently displayed source highlight. Its `pagehide` and
`unload` lifecycle handlers clear that exact page or PDF highlight before the
side-panel document is destroyed; ownership IDs prevent stale cleanup from
erasing a newer highlight.

## Mutation and ambiguity policy

Before highlighting, the content script verifies the route, stable source
scope, rendered state, and mapped characters for the heatmap-resolved source
span.
Unrelated nodes elsewhere in the captured selection may hydrate or rerender
without invalidating an unchanged target. A connected target Text node whose
data React changed in place is still rejected.

If target nodes were replaced, the resolver first tries an exact
complete-selection rebase, preserving the server's original occurrence
offsets. It then constructs a fresh, rendered-text projection beneath the same
Gmail message ID, WhatsApp serialized message ID, public X tweet ID, logged-in
X status permalink, X Article root, uniquely headed semantic `article`, or
conservative generic scope. The projection is case-sensitive, maps every
DOM-backed character back to a live Text node, and treats synthetic block
separators as normalized whitespace so node split/merge and block-to-inline
wrapper changes do not alter the quote.

Repeated quotes require a unique bounded prefix/suffix context captured from
the boundary block and semantic scope, including immediately outside the
selection. A lone quote without matching context is accepted only when its live
Range still occupies the captured source path and raw offsets. Paths and
occurrence order are hints, never sufficient evidence after a reorder. A stable
source is never allowed to fall through to a page-wide match, where the same
words might belong to another message, post, or article region. Fresh
projections are built lazily on an answer selection and have source/candidate
caps; the extension does not observe or mirror page mutations continuously.

Identity-less captures may use a body-wide fallback only when the complete
captured text or context-validated quote proves one occurrence. Missing,
duplicate, route-mismatched, or changed-target matches fail visibly; the
extension does not use `window.find` or select the first arbitrary copy.

A refreshed page is the extreme case: the frame holds no extraction at all, and
the panel's `highlight` message carries the cached canonical document with it.
Because the frame holds no capture, it has none to protect, so it may stand in
the cached document for the lost extraction — first by rebuilding the whole map
when the reloaded page still matches that document exactly, and otherwise by
projecting only the attributed quote, with bounded 48-character prefix and
suffix contexts, into the live body. One live occurrence (or one that the cached
context singles out) is the identity; ties, changed text, and vanished passages
fail, and the panel reports “Couldn't locate that text in the page.” Each
applied highlight records the panel's per-click ownership ID, so a recovered
highlight can still be cleared even though the frame holds no capture ID.

## Message protocol

| From → To | Type | Important payload |
|---|---|---|
| background → content frame | `capture-selection` | `captureId`, `selectionText`, targeted `frameId` |
| background → content frame | `capture-page` | `captureId`, targeted `frameId` |
| background → panel | `selection-captured` | `captureId`, `capturedAt`, tab/window/frame IDs, `captureMode`, `sourceType`, URL, and `text` or `error` |
| panel → background | `capture-tab-for-chat` | tab ID to capture as a full page without opening the panel |
| panel → background | `clear-tab-highlights` | tab ID whose page highlight must be cleared |
| panel → content frame | `highlight` | `captureId`, `highlightId`, `start`, `end`, cached `document` for reload recovery, targeted `frameId` |
| panel → content frame | `clear-highlight` | `captureId`, optional owning `highlightId`, targeted `frameId` |
| panel → background | `highlight-pdf-source` | PDF tab/URL, canonical document, resolved `start` and `end` |
| panel → background | `clear-pdf-source-highlight` | PDF tab/URL |
| panel → background | `cancel-pdf-source-operation` | PDF tab ID whose pending navigation must be invalidated |

## Native PDF attribution

The panel resolves PDF heatmaps with the same just-in-time aggregation used for
web pages. The worker trims the resolved span, collapses line whitespace, and
builds a standard PDF text fragment with bounded prefix/suffix context. Long
spans use separate bounded start and end text, preventing unbounded navigation
URLs. Fragment grammar punctuation is percent-encoded.

Chrome's PDF viewer recognizes `#:~:text=` only during viewer load. The worker
therefore updates the existing PDF tab, waits for that navigation to commit,
then reloads it once. PDFium highlights the matched text and scrolls to it.
Repeated clicks replace the prior directive without a preliminary clear/reload;
the Clear action removes only the text directive and preserves normal
`#page`/`#zoom` state. Text-fragment and viewer-anchor URL changes do not
invalidate the capture, while a different path or query does. A genuine
navigation drops highlight ownership without issuing a PDF clear, which would
otherwise navigate the user back to a document they left.

PDF support is limited to top-level, text-searchable files opened directly in
Chrome's native viewer. Embedded PDFs are deliberately treated as ordinary
pages so the extension can never navigate or reload their outer HTML tab.
Scanned/image-only PDFs require OCR. Full-PDF source text comes from PDFium's
own selection model, keeping generation/heatmap offsets aligned with the native
viewer used for attribution. Context around a source span disambiguates most
repeated phrases, but completely identical repeated passages cannot be
guaranteed. Each PDF fragment update also creates a session-history entry:
Chrome exposes tab navigation and reload, but no replace-in-place API for its
protected viewer.

## Lifecycle and non-goals

A source-document URL change invalidates source mapping and requires a new
capture. Fragments never count as such a change: a plain `#section` anchor, the
extension's own `:~:text=` directive, and the native PDF viewer's `#page`/`#zoom`
parameters all move the viewport inside one document, so the chat survives them.
`content.js` applies the same rule to its own route key, and the page-chat cache
key strips fragments (and `utm_*`/tracking parameters, and sorts the remaining
query) for the same reason. Capture IDs, context versions, highlight epochs, and
per-highlight ownership IDs prevent stale generation or click work from
overwriting or clearing a newer capture's highlight. Balance observations are
similarly sequenced so a delayed credits read cannot replace a newer
post-request balance.

Chats are persisted per page in IndexedDB (`tokenpath-page-chats`, schema
version 2: one record per page key, storing each distinct captured document once
and referencing it from the messages that were attributed against it). A record
holds the captured context, message list, bounded history, and cached heatmaps.
Reopening or returning to a page restores it without an API call; a fresh
capture whose content differs significantly from the cached one — judged by
sampled 5-word shingles and a length ratio — deletes the record and posts a
dismissible note that a new chat was started. Retention runs once per panel
session over a `savedAt` index: at most 50 records, least-recently-saved first,
and nothing older than 30 days. **Clear chat** deletes the current page's
record; **Disconnect** clears the whole store along with the saved key, because
those records hold captured page and PDF text.

The panel is wrapped in a React error boundary, and `main.tsx` renders an
explicit failure state if `panel-logic.js` or `tokenpath.js` did not load, so
neither case can leave a blank side panel.

Out of scope for this version: Readability/article-only extraction, cross-frame
page concatenation, shadow-root traversal, unmounted virtualized content, OCR,
OAuth, user-selectable models, and restricted Chrome pages. A capture belongs to
one frame; cross-frame selections are unsupported. The model behind TokenPath's
messages-only `/v1/generate` is intentionally not user-selectable.
