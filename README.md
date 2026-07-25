# chat-with-page

**TLDR** is a Chrome MV3 extension for chatting with text selected on a web
page. Select text, right-click **TLDR**, then use the side panel to summarize it
or ask follow-up questions. Select any part of an answer to highlight and scroll
to the source text that most strongly supports it.

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
5. Select text on a normal web page, right-click, and choose **TLDR**.

On first use, paste a TokenPath API key from
[platform.tokenpath.ai](https://platform.tokenpath.ai). The same key covers
streaming generation and attribution; no separate model-provider key is needed.

Selections of 24 words or fewer are already concise, so the extension skips the
automatic model summary. Longer selections get an adaptive TL;DR prompt and
output-token ceiling that scale with the source while remaining shorter than it.
Long CJK text uses an equivalent character budget instead of being mistaken for
a one-word selection.

## How it works

1. Content scripts run from `document_start` in every frame. They snapshot the
   live selection and eagerly extract it on `contextmenu`, before a dynamic page
   such as Gmail, WhatsApp, or Substack can replace or normalize its DOM
   selection.
2. The background worker starts an idempotent injection into the exact source
   frame, covering tabs that were open before an extension reload. It opens the
   side panel without awaiting its animation and captures immediately. A missing
   listener or stale capture response is retried once after injection. Once the
   DOM map is safely captured, the native page selection is cleared.
3. TokenPath streams the answer from `POST /v1/generate` using a messages-only
   request. The extension owns the system prompt, exact selected document,
   bounded conversation history, and latest question; TokenPath chooses the
   inexpensive model. Named `delta` events update the panel, while the terminal
   `done.answer` becomes the canonical final text.
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

The exact extracted selection, questions, bounded conversation context, and
generated answer are sent to TokenPath. DOM nodes, page structure, unrelated
page text, and the extraction-to-node map remain inside the source frame.

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
├── background.js              # nonblocking, frame-aware capture
├── content.js                 # extraction, node map, remap, highlight
├── content.css                # source attribution highlight
├── package.json               # side-panel build and complete validation
├── vite.config.ts             # local MV3-compatible JS/CSS bundle
├── src/sidepanel/
│   ├── app.tsx                # React chat, auth, source context, themes
│   ├── controller.ts          # capture/auth/chat/highlight state machine
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
