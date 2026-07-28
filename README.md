# TokenPath — Chat with Attribution

**TokenPath — Chat with Attribution** is a Chrome MV3 extension for working with
text on a web page or in Chrome's native PDF viewer. Right-click, open the
**TokenPath** submenu, and choose **TLDR**, **Simplify**, or **Ask a question**.
A selection takes precedence; without one, TokenPath uses the rendered text in
the current page or frame—or the entire searchable PDF. Select any part of an
answer to highlight and scroll to the source text that most strongly supports
it.

## Load it unpacked

1. Build the side panel once:

   ```sh
   cd tldr-extension
   npm install
   npm run build
   ```

2. Open `chrome://extensions`.
3. Enable **Developer mode**.
4. Choose **Load unpacked** and select `tldr-extension/`.
5. Right-click a normal web page and open the **TokenPath** submenu. Choose
   **TLDR**, **Simplify**, or **Ask a question**. Select a passage first to use
   only that text; invoke an action without a selection to use the full rendered
   page or searchable PDF.

On first use, paste a TokenPath API key from
[platform.tokenpath.ai](https://platform.tokenpath.ai). The same key covers
streaming generation and attribution; no separate model-provider key is needed.

## Build the Chrome Web Store package

From `tldr-extension/`, run:

```sh
npm run package:store
```

This validates and rebuilds the side panel, then creates
`dist/tokenpath-chat-with-attribution-<version>.zip` with `manifest.json` at the
archive root. The store package contains only runtime files and requests access
only to `https://api.tokenpath.ai`; staging and localhost permissions remain
available only when the repository is loaded unpacked.

Before uploading an update, increment `version` in `manifest.json`. Chrome Web
Store package versions must always increase.

Pushes and pull requests also run the complete suite in GitHub Actions and
publish the store ZIP as a downloadable workflow artifact. A matching
`v<manifest-version>` tag creates a GitHub Release with that ZIP attached. Use
`npm run version:set -- 0.1.1` to update `manifest.json`, `package.json`, and the
lockfile together. Prepared listing copy, permission explanations, privacy
checks, and reviewer instructions are in
[`docs/chrome-web-store.md`](./docs/chrome-web-store.md).

The three actions share the same attributed chat:

- **TLDR** starts a summary immediately. Sources of 24 words or fewer are
  already concise, so this action skips model generation and shows an
  “Already concise” note.
- **Simplify** immediately explains the source in plainer language.
- **Ask a question** captures the source and opens the composer without making a
  generation or attribution request. Nothing is generated until the user
  submits a question.

A persistent Short / Medium / Detailed control changes both the TLDR prompt's
requested detail and generous output headroom (512 / 768 / 1024 tokens), so
length is directed by the model rather than enforced with a sentence-cutting
cap. Short is the default. Long CJK text uses a character-aware cutoff instead
of being mistaken for a one-word selection.

## How it works

1. Content scripts run from `document_start` in every frame. They snapshot the
   live selection and eagerly extract it on `contextmenu`, before a dynamic page
   such as Gmail, WhatsApp, or Substack can replace or normalize its DOM
   selection. The chosen TokenPath submenu action travels with that capture:
   TLDR and Simplify start their initial turn, while Ask a question waits for a
   submitted question. With no selection on an HTML page, the content script
   instead builds one canonical map of the rendered text in the exact frame
   where the menu opened.
2. The background worker starts an idempotent injection into the exact source
   frame, covering tabs that were open before an extension reload. It opens the
   side panel without awaiting its animation and captures immediately. A missing
   listener or stale capture response is retried once after injection. Once the
   DOM map is safely captured, a native page selection is cleared when present.
   Chrome's protected PDF viewer cannot accept that injection. After verifying
   the tab's `application/pdf` MIME type, selected PDF passages use the exact
   context-menu text. With no selection, the panel fetches the PDF using the
   click's temporary `activeTab` access, loads a hidden Blob copy in Chrome's
   native viewer, and asks PDFium for its full searchable text. The hidden copy
   is then destroyed, so the visible PDF is never selected or reloaded during
   capture.
3. When an action calls for generation, TokenPath streams the answer from
   `POST /v1/generate` using a messages-only request. The extension owns the
   system prompt, exact selected document, bounded conversation history, and
   latest question; TokenPath chooses the inexpensive model. Named `delta`
   events update the panel, while the terminal `done.answer` becomes the
   canonical final text. Ask does not reach this step until the user submits
   the composer.
4. The panel uses Vercel
   [AI Elements](https://elements.ai-sdk.dev/) conversation, message, and
   prompt-input primitives. Assistant answers render as safe Markdown through
   Streamdown while tokens arrive. After generation, one authenticated
   `POST /v1/attributions/heatmap` request maps the complete answer to the
   selected document. TokenPath's sparse matrix and Unicode code-point offset
   tables are validated, converted once to JavaScript UTF-16 offsets, and cached
   with that answer.
5. Selecting any rendered answer text—including text across Markdown blocks,
   emphasis, links, inline or fenced code, entities, and Unicode—maps the DOM
   selection back to its exact raw-answer character range. A local port of
   TokenPath's span resolver aggregates the cached heatmap just in time and
   derives one supported source range. Changing the answer selection makes no
   additional API call.
6. The content script maps those document offsets back to live DOM `Range`s`,
   highlights the source with the CSS Custom Highlight API, and scrolls it into
   view, including through nested panes such as Gmail's message view.
   For a PDF, the background worker converts the same resolved range into a
   contextual `#:~:text=` directive. Chrome's native viewer reloads once, then
   highlights the matching PDF text and scrolls it into view. Ordinary PDF
   page/zoom anchors are preserved. Closing the side panel clears the highlight
   it owns.

PDF capture and attribution currently require a top-level, text-searchable PDF
opened directly in Chrome's native viewer. Full-PDF capture accepts downloads up
to 50 MiB and uses at most the first 400,000 Unicode characters. PDFs embedded
inside another web page, image-only scans, and files the extension cannot fetch
are not supported. Contextual text around a resolved span distinguishes most
repeated phrases; a completely identical repeated passage can remain ambiguous.
Clicking an attribution reloads the PDF (normally from cache) because Chrome
applies PDF text-fragment highlights only during viewer load. Chrome also
records each fragment change in the tab's Back history; its extension API does
not provide replace-in-place PDF highlighting.

Full-page HTML capture uses at most the first 400,000 UTF-16 characters of
rendered text in the originating frame. It excludes hidden/script/style text
and keeps visible `user-select: none` content, but it cannot include descendant
frames, closed shadow roots, canvas text, form-control values, or content an
infinite-scroll/virtualized app has not mounted yet. Extremely fragmented or
raw-text-heavy DOMs may stop earlier to keep renderer work bounded.

The heatmap resolver's source character bounds disambiguate repeated strings in
the original extraction. If the selected answer text also occurs verbatim in
the source, it only snaps to an occurrence overlapping the heatmap-supported
range, with nearest-center selection among candidates. Before navigating, the
extension validates only the resolved source span, so unrelated hydration
elsewhere in a long selection cannot break an unchanged target. If a dynamic
page replaces the target subtree, a shared DOM resolver searches only beneath
the original Gmail or WhatsApp message, X post/status/article identity, uniquely
headed semantic article, or conservative generic scope. Its case-sensitive
quote projection tolerates text-node split/merge and block-wrapper whitespace
changes; bounded prefix/suffix context disambiguates reordered repeats. Exact
source identities and validated paths keep other messages or surviving
duplicates from stealing the highlight. Changed routes, changed targets, and
ambiguous matches fail instead of jumping to the first copy.

Late-injection recovery also handles invisible formatting characters, Unicode
whitespace, CSS-uppercase text, and effective `user-select` overrides. This
excludes genuinely unselectable controls on Substack and X while accepting
WhatsApp message text re-enabled beneath its non-selectable app shell.

The exact extracted selection, rendered full-page text, or searchable full-PDF
text—plus questions, bounded conversation context, and generated answers—is
sent to TokenPath. DOM nodes, page structure, and the extraction-to-node map
remain inside the source frame.

The panel follows the operating-system theme by default. Its header control can
switch among system, light, and dark modes; the preference stays local to the
extension.

## API and local development

The side panel calls TokenPath directly using a key stored in
`chrome.storage.local`. To use a staging or local backend, run this in the panel
DevTools console:

```js
chrome.storage.local.set({ tokenpathBaseUrl: "http://localhost:8000" })
```

See [`tokenpath-integration.md`](./tokenpath-integration.md) for request shapes
and [`spec.md`](./spec.md) for the extension architecture.

The page-capture scripts remain build-free. The side panel is a React 19,
TypeScript, Tailwind CSS 4, and Vite bundle. AI Elements components are copied
into the repository as editable source, matching the library's shadcn-style
distribution model. Run the complete validation from `tldr-extension/`:

```sh
npm install
npm run setup:test # first run on a machine
npm test
```

## Layout

```text
tldr-extension/
├── manifest.json
├── background.js              # frame/page/PDF capture and PDF navigation
├── content.js                 # extraction, node map, remap, highlight
├── content.css                # source attribution highlight
├── package.json               # side-panel build and complete validation
├── vite.config.ts             # local MV3-compatible JS/CSS bundle
├── src/sidepanel/
│   ├── app.tsx                # React chat, auth, source context, themes
│   ├── controller.ts          # capture/auth/chat/highlight state machine
│   ├── pdf-text-extractor.ts  # hidden native-PDF full-text capture
│   ├── answer-selection.ts    # rendered Markdown → raw-answer offsets
│   └── components/
│       ├── ai-elements/       # adapted Vercel AI Elements source
│       └── ui/                # local shadcn-style primitives
└── sidepanel/
    ├── panel.html
    ├── panel.js               # generated React/AI Elements bundle
    ├── panel.css              # generated Tailwind/theme bundle
    ├── panel-logic.js         # summary helpers and heatmap span resolver
    └── tokenpath.js           # streaming generation + heatmap client
```

Test instructions and coverage are in
[`tldr-extension/test/README.md`](./tldr-extension/test/README.md).
