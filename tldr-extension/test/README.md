# Tests

The suite has pure/unit coverage for offset math, summary policy, and background
capture orchestration, plus Playwright integration coverage for the side panel
and real content script.

From `tldr-extension/`, build the packaged panel and run everything:

```bash
npm install
npm run setup:test # first run on a machine
npm test
```

## Unit suite

```bash
npm run test:unit
```

This runs five files:

- **`roundtrip.test.cjs`** checks canonical extraction offsets against raw DOM
  offsets, including synthetic block separators, headings, and exact
  sub-sentence ranges without sentence expansion.
- **`panel-logic.test.cjs`** checks the 24-word automatic-summary cutoff,
  the absence of a low automatic-summary output cap, code-point-safe truncation
  around emoji, TokenPath code-point to browser
  UTF-16 offset conversion, whitespace-free CJK handling, and the service-parity
  heatmap resolver across sparse mass, weak-token gaps, repeated source text,
  missing mass, and emoji.
- **`api-clients.test.cjs`** exercises TokenPath's named generation SSE across
  byte-fragmented Unicode, terminal and error events, malformed/incomplete
  streams, caller cancellation, canonical `done.answer`, HTTP error details,
  heatmap validation, code-point offset conversion, and cancellation or timeout
  while a response body is still arriving.
- **`pdf-text-extractor.test.cjs`** verifies fragment-free credentialed PDF
  downloads, signature and 50 MiB limits, strict native-viewer reply binding,
  Unicode-safe 400,000-character truncation, scan/timeout/abort failures, and
  unconditional hidden-viewer cleanup.
- **`background.test.cjs`** holds `chrome.sidePanel.open()` unresolved and proves
  that capture still proceeds immediately. It also verifies exact-frame warm
  injection, retries for missing receivers and stale “page changed” responses,
  Gmail or nested-frame routing, click-order race handling, seed metadata, and
  startup migration from the older single context-menu item to a **TokenPath**
  submenu with **TLDR**, **Simplify**, and **Ask a question** actions.
  Native-PDF coverage includes legacy and modern OOPIF detection, direct
  context-menu capture, full-document descriptor routing for no-selection
  clicks, exact-frame full-page HTML routing for all three actions,
  bounded/contextual text-fragment encoding (including Unicode and reserved grammar),
  URL-commit-before-reload ordering, and clearing highlights without losing
  ordinary PDF anchors.

## Browser integration

```bash
npm run test:e2e
```

`e2e.mjs` loads representative fixtures and public pages, injects the real
scripts behind a small Chrome API shim, and drives selection → **TokenPath**
submenu action → capture → optional streaming generation → cached heatmap →
arbitrary answer selection → source-offset highlight. TLDR summarizes,
Simplify explains in plainer language, and Ask a question makes no generation
or attribution request until the composer is submitted. It covers:

- side-panel bootstrap while `/credits` never resolves, persisted Short /
  Medium / Detailed summary length and generation headroom, a messages-only TokenPath
  `/v1/generate` request, split named SSE
  events, one TokenPath heatmap per answer, and reuse of that heatmap across
  different answer selections; exact raw-answer mapping across inline/fenced
  and indented code, real mouse selection in link labels, bold delimiters,
  block crossings, decoded entities, footnote definitions, hidden link
  destinations/image alt text, repeated text, and Unicode; serialized
  disconnect/key removal so a late delete cannot race a reconnect;
  collapsed-by-default source text with accessible expansion, automatic
  recollapse on replacement, always-visible capture errors, narrow-panel
  layout, system/light/dark theme switching, code-point offset conversion
  across a LinkedIn-shaped emoji, stale-seed rejection, and routing the resolved
  source range to the original tab and frame;
- delayed auth cleanup after a newer capture, out-of-order credit reads, rapid
  answer-selection responses, and content-script highlight ownership, proving
  stale async work cannot write into or clear newer UI state, plus side-panel
  teardown cleanup for owned page and PDF highlights;
- native-PDF panel routing through the background worker, reuse of the normal
  generation/heatmap path, same-document text-fragment and viewer-anchor
  updates, explicit clearing, and genuine-navigation invalidation without
  bouncing the tab back to the old PDF;
- full-PDF reading state, hidden native-viewer extraction, normal
  generation/heatmap reuse, and replacement races where a newer capture aborts
  the old read and ignores its delayed viewer reply;
- full-page rendered-text capture that ignores a stale selection, includes
  visible non-selectable text, excludes hidden/script/style text, safely caps a
  surrogate-boundary prefix, and preserves repeated-phrase attribution after a
  DOM replacement;
- a Gmail-shaped nested scroll pane whose complete message subtree is replaced
  between capture and highlight, including repeated text and inline elements;
- a WhatsApp-shaped selection spanning link-preview text and a later image
  caption beneath a non-selectable app shell, including metadata exclusion,
  subtree replacement, unrelated message hydration, exact serialized-message
  recovery despite duplicate captions, changed-target rejection, and selection
  cleanup;
- a dynamic SSR article whose subtree hydrates after capture, including an
  unrelated lead edit, a duplicate target outside the article, and exact
  clicked-span recovery beneath the article heading;
- generalized semantic-scope recovery across split and merged text nodes,
  inserted or removed wrappers that change synthetic block separators,
  DOM Ranges that omit those generated separators, and same-node edits outside
  the clicked span;
- repeated target text reordered within one article, including quote-context
  disambiguation from context outside a whole-node selection, rejection of
  indistinguishable candidates, rejection of mutations inside the actual
  target (including ZWJ removal), and no fallback jump to a surviving duplicate
  when the originally attributed occurrence changes;
- duplicated generic element IDs falling back to page-level contextual
  disambiguation instead of trusting the first invalid-ID match;
- rejection after query/hash route identity changes;
- exact Range capture when Chrome's flattened selection hint omits an invisible
  character, followed by clearing the native page selection without losing
  later heatmap-resolved highlighting;
- a Substack-shaped late-injection selection spanning header and body, including
  CSS-uppercase dates, `user-select:none` reaction controls, and a visibly
  rendered `aria-hidden` ancestor;
- current X Article DraftJS selectors and blocks, repeated text, and a full
  article subtree rerender;
- X post identity across detach and reorder when another post contains the same
  text, plus rejection of a connected React Text node whose contents changed;
- a live public X post body, including a React-rendered span replacement; and
- single-node and multi-block extraction and highlighting on Example,
  Wikipedia, GNU, MDN, Hacker News, the live FLUX 3 article, a live Substack
  post, and a live X profile.

To run both levels:

```bash
npm test
```

## Linux browser dependencies

Headless Chromium may need `libgbm.so.1` and `libwayland-server.so.0`.
`setup-libs.sh` downloads and extracts them without root into `_libs/flat/`, and
`e2e.mjs` adds that directory to `LD_LIBRARY_PATH`. If system installation is
available, `npx playwright install-deps chromium` is the standard alternative.

## Still manual

The tests mock rather than launch a packaged Chrome extension, so a final
load-unpacked pass should first verify that the **TokenPath** submenu exposes
**TLDR**, **Simplify**, and **Ask a question**. Confirm that TLDR summarizes,
Simplify starts a plain-language explanation, and Ask a question opens a
captured chat without a generation or attribution request until submit. The
pass should also verify the
side panel, TokenPath HTTP/authentication flow, streamed Markdown, selecting
arbitrary answer text to navigate, repeated selections without new attribution
calls, nested Gmail scrolling, detached-DOM unique remapping, and searchable-PDF
selection or full-document capture/highlight/clear behavior. Also right-click
ordinary HTML without a selection and verify that the panel labels and
attributes the entire rendered page. Restricted pages
such as `chrome://` remain unavailable to content scripts by design; PDFs are
handled separately through Chrome's native viewer. The PDF pass should use a
top-level searchable file, first right-click without a selection and confirm
that the hidden-copy read leaves the visible viewer untouched, then confirm that
the native viewer finds an attributed span (including a repeated phrase with
context). Inspect Back/Clear behavior because Chrome records fragment
navigation in session history. An embedded PDF should remain unsupported
without navigating or reloading its outer page.

Deterministic fixture failures set a nonzero exit code. Public-site smoke checks
remain diagnostic because network availability and third-party markup can
change independently of the extension.
