# Spec: TokenPath — Chat with Attribution

## Goal

TokenPath — Chat with Attribution is a Chrome Manifest V3 extension. A user
right-clicks a page or Chrome's native PDF viewer, opens the **TokenPath**
context-menu submenu, and chooses **TLDR**, **Simplify**, or **Ask a question**.
A selection uses only that span. Invoking an action without a selection uses
the rendered text of the originating page/frame or the entire top-level
searchable PDF. The resulting side-panel chat is grounded in that source text.
TokenPath streams each answer, then returns one answer-to-document heatmap.
Selecting any part of an answer resolves that range against the cached heatmap,
highlights its supporting source range, and scrolls there in the live page or
PDF.

## User flow

1. Right-click a page, nested frame, or searchable PDF, open the **TokenPath**
   submenu, and choose an action. A selection takes precedence; without one,
   the originating HTML frame or top-level PDF becomes the source.
2. The panel confirms capture immediately in a compact source row,
   independently of API-key validation or credit refresh. The full captured
   text is collapsed by default and can be expanded on demand.
3. The initial action determines what happens next:
   - **TLDR** immediately requests a length-controlled summary when the source
     exceeds the concise-source cutoff; shorter sources show an “Already
     concise” note without generation.
   - **Simplify** immediately requests a plain-language explanation.
   - **Ask a question** opens the composer with the source ready but makes no
     generation or attribution request until the user submits a question.
4. Continue with follow-up questions in the same composer and attributed chat.
5. Select any text in a completed answer to highlight and center its supporting
   source text in the originating page frame or PDF.

## Components

- **`manifest.json`** injects `content.js` and `content.css` at
  `document_start` with `all_frames`, `match_about_blank`, and
  `match_origin_as_fallback` enabled.
- **`background.js`** owns the TokenPath submenu and its TLDR, Simplify, and Ask
  a question actions; starts the side-panel open; captures from `info.frameId`;
  detects native PDFs; stores and broadcasts a versioned selection seed plus
  action; and owns PDF text-fragment navigation/reload.
- **`content.js`** snapshots selections, creates the canonical text-to-DOM map,
  extracts full rendered pages when requested, resolves document offsets,
  repairs mappings after supported DOM rerenders, renders the source highlight,
  and scrolls nested panes.
- **`src/sidepanel/controller.ts`** manages auth, chat history, summary policy,
  full-PDF extraction, capture/version epochs, and frame-targeted highlight
  messages.
- **`src/sidepanel/pdf-text-extractor.ts`** fetches a verified PDF and uses a
  hidden Blob-backed instance of Chrome's native viewer to obtain PDFium's
  searchable text.
- **`src/sidepanel/app.tsx`** renders the React panel with source-owned Vercel
  AI Elements conversation, message, and prompt-input primitives.
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
  heatmaps, and adapts their offset tables for browser use.

## Selection capture and panel bootstrap

The context-menu callback supplies flattened `selectionText` but not DOM nodes.
The parent **TokenPath** item contains three children—**TLDR**, **Simplify**, and
**Ask a question**—across supported selection, page, and frame contexts. Each
frame listens for selection changes, clones the current `Range`, and eagerly
extracts it during `contextmenu`.

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

Every seed carries the chosen action together with `captureId`, `capturedAt`,
`tabId`, `windowId`, and `frameId`. IDs are allocated before extraction, so
click order—not async completion order—defines freshness. The panel installs
its live listener before active-tab lookup, seed replay, or credit validation.
Duplicate and stale seeds cannot replace a newer selection, start the wrong
initial turn, or change its highlight route.

Chrome's built-in PDF viewer is a protected component extension, so ordinary
content scripts cannot read its DOM or receive highlight messages. For every
PDF context-menu click, the worker probes the top-level document's MIME type and
marks the seed `sourceType: "chrome-pdf"` while retaining the original PDF URL.
With a selection, `OnClickData.selectionText` is the canonical document. With
no selection, the seed uses `captureMode: "full-pdf"` and contains only a small
descriptor. The side panel fetches that URL using the context-menu click's
temporary `activeTab` access, verifies and bounds the bytes, then creates an
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

For the TLDR action, captured sources of 24 whitespace-delimited words or fewer
skip the automatic model call. Whitespace-free CJK sources use an equivalent
48-character cutoff instead of being mistaken for a one-word selection.

Longer selections use a locally persisted Short / Medium / Detailed preference:

- Short (default): about 2–3 concise sentences, with 512 tokens of headroom.
- Medium: about 4–6 concise sentences, with 768 tokens of headroom.
- Detailed: about 8–12 concise sentences, with 1024 tokens of headroom.

The prompt allows an equivalently sized list or table when structured formatting
is clearer, and forbids a title, label, preamble, explanation, or closing
comment. These token values are generous ceilings rather than target lengths;
the prompt controls concision without cutting off a sentence. The terminal
`done.answer` is preserved unchanged for display, history, and attribution.
There is no client-side clipping or extractive fallback. Document and
conversation limits are counted by Unicode code point so truncation does not
split surrogate pairs.

## Streaming generation and just-in-time heatmap attribution

TLDR and Simplify start an initial turn after capture; Ask a question
intentionally does not. Its captured source may be inspected in the panel, but
no generation or attribution request is made until the user submits the
composer. Once a turn starts, the generator uses one streaming
`POST /v1/generate` request. Its body
contains only messages and an optional `max_output_tokens`:

- a system message containing the website origin, exact canonical document,
  and conditional Markdown formatting instructions;
- bounded prior user and assistant turns; and
- the latest user question.

TokenPath chooses the model. Named SSE `delta` events update one stable
assistant message; the terminal `done.answer` is canonical and may replace the
locally accumulated deltas. Navigation, a newer capture, or disconnect cancels
active generation. The exact terminal answer is added to history and sent to
attribution without client-side rewriting.

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

## Message protocol

| From → To | Type | Important payload |
|---|---|---|
| background → content frame | `capture-selection` | `captureId`, `selectionText`, targeted `frameId` |
| background → content frame | `capture-page` | `captureId`, targeted `frameId` |
| background → panel | `selection-captured` | chosen action, `captureId`, time, tab/window/frame IDs, `captureMode`, `sourceType`, URL, and `text` or `error` |
| panel → content frame | `highlight` | `captureId`, `highlightId`, `start`, `end`, targeted `frameId` |
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
capture. PDF viewer fragments are ignored because they do not change the source
document. Capture IDs, context versions, highlight epochs, and per-highlight
ownership IDs prevent stale generation or click work from overwriting or
clearing a newer selection's highlight. Balance observations are similarly
sequenced so a delayed credits read cannot replace a newer post-request balance.

Out of scope for this version: Readability/article-only extraction, cross-frame
page concatenation, shadow-root traversal, unmounted virtualized content,
persisted chats, OCR, OAuth, user-selectable models, and restricted Chrome
pages. A capture belongs to one frame; cross-frame selections are unsupported.
The model behind TokenPath's messages-only `/v1/generate` is intentionally not
user-selectable.
