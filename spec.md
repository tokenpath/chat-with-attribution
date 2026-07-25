# Spec: TLDR Chrome Extension

## Goal

TLDR is a Chrome Manifest V3 extension. A user selects text in a page, chooses
**TLDR** from the context menu, and receives a side-panel chat grounded in that
selection. TokenPath streams each answer, then returns one answer-to-document
heatmap. Selecting any part of an answer resolves that range against the cached
heatmap, highlights its supporting source range, and scrolls there in the live
page.

## User flow

1. Select text in a page or nested frame and choose **TLDR**.
2. The panel displays the captured text immediately, independently of API-key
   validation or credit refresh.
3. For selections longer than 24 words, the panel automatically requests a
   constrained TL;DR. Shorter selections skip generation and show an
   “Already concise” note.
4. Ask follow-up questions in the composer.
5. Select any text in a completed answer to highlight and center its supporting
   source text in the originating page frame.

## Components

- **`manifest.json`** injects `content.js` and `content.css` at
  `document_start` with `all_frames`, `match_about_blank`, and
  `match_origin_as_fallback` enabled.
- **`background.js`** owns the context menu, starts the side-panel open, captures
  from `info.frameId`, and stores and broadcasts a versioned selection seed.
- **`content.js`** snapshots selections, creates the canonical text-to-DOM map,
  resolves document offsets, repairs mappings after supported DOM rerenders,
  renders the source highlight, and scrolls nested panes.
- **`src/sidepanel/controller.ts`** manages auth, chat history, summary policy,
  capture/version epochs, and frame-targeted highlight messages.
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
Each frame therefore listens for selection changes, clones the current `Range`,
and eagerly extracts it during `contextmenu`.

`chrome.sidePanel.open()` must begin synchronously in the click gesture, but the
background worker does not await it. It first starts an idempotent script and CSS
injection into the originating `frameId`, covering tabs that predate an unpacked
extension reload, then immediately sends `capture-selection`. Missing receivers
and content-level capture failures are retried once after injection completes.
This ordering keeps the panel animation and credit lookup off the capture path.

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

Every seed carries `captureId`, `capturedAt`, `tabId`, `windowId`, and `frameId`.
IDs are allocated before extraction, so click order—not async completion
order—defines freshness. The panel installs its live listener before active-tab
lookup, seed replay, or credit validation. Duplicate and stale seeds cannot
replace a newer selection or change its highlight route.

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

For a source of `N` whitespace-delimited words:

- `N <= 24`: skip the automatic model call.
- Otherwise request at most `min(80, max(12, floor(0.3 * N)))` words.
- Set `/v1/generate`'s `max_output_tokens` to
  `min(128, max(16, ceil(maxWords * 1.6)))`.

The prompt asks only for the central point, with no title, label, preamble,
explanation, or closing comment. A long whitespace-free CJK selection uses a
proportional character budget instead. A deterministic display guard substitutes
a bounded extractive prefix if the model's result is not strictly shorter or
exceeds the requested budget. Document and conversation limits are counted by
Unicode code point so truncation does not split surrogate pairs.

## Streaming generation and just-in-time heatmap attribution

The generator uses one streaming `POST /v1/generate` request per turn. Its body
contains only messages and an optional `max_output_tokens`:

- a system message containing the exact canonical document plus grounding and
  display instructions;
- bounded prior user and assistant turns; and
- the latest user question.

TokenPath chooses the model. Named SSE `delta` events update one stable
assistant message; the terminal `done.answer` is canonical and may replace the
locally accumulated deltas. Navigation, a newer capture, or disconnect cancels
active generation. The automatic-summary display guard runs after `done` and
before attribution, so TokenPath always indexes the exact answer that remains
visible.

Once generation finishes, the panel sends one
`POST /v1/attributions/heatmap` request:

```js
{
  document: "the canonical extracted selection",
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
| background → panel | `selection-captured` | `captureId`, time, tab/window/frame IDs, `text` or `error` |
| panel → content frame | `highlight` | `captureId`, `highlightId`, `start`, `end`, targeted `frameId` |
| panel → content frame | `clear-highlight` | `captureId`, optional owning `highlightId`, targeted `frameId` |

## Lifecycle and non-goals

A URL change invalidates source mapping and requires a new capture. Capture IDs,
context versions, highlight epochs, and per-highlight ownership IDs prevent stale
generation or click work from overwriting or clearing a newer selection's
highlight. Balance observations are similarly sequenced so a delayed credits
read cannot replace a newer post-request balance.

Out of scope for this version: whole-page or Readability extraction,
shadow-root traversal, persisted chats, OAuth, user-selectable models, and
restricted Chrome pages. A selection belongs to one frame; cross-frame
selections are unsupported. The model behind TokenPath's messages-only
`/v1/generate` is intentionally not user-selectable.
