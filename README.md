# TokenPath — Chat with Attribution

**TokenPath — Chat with Attribution** is a Chrome MV3 extension that opens an
attributed chat about a web page, a passage inside it, or Chrome's native PDF
viewer. Click the toolbar icon for a one-click summary of the whole page, or
select a passage, right-click, and choose the single **Chat with TokenPath**
context-menu item.
Every answer can be traced back: click an underlined phrase, select any part of
the answer, or open its **Sources** list, and the extension highlights and
scrolls to the source text that most strongly supports it.

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
5. Click the TokenPath toolbar icon to capture the active page and immediately
   get an attributed three-bullet summary of it, then ask follow-up questions
   in the same chat. To chat about one passage instead, select it first,
   right-click, and choose **Chat with TokenPath**.

On first use, paste a TokenPath API key from
[platform.tokenpath.ai](https://platform.tokenpath.ai). The same key covers
streaming generation and attribution; no separate model-provider key is needed.

## Build the Chrome Web Store package

From `tldr-extension/`, run:

```sh
npm run package:store
```

This runs the full check, then builds
`dist/tokenpath-chat-with-attribution-<version>.zip` with `manifest.json` at the
archive root (`npm run package:store:ci` is the CI variant that skips the
redundant re-check). The package contains only runtime files and declares
exactly two host permissions, `<all_urls>` and `https://api.tokenpath.ai/*`;
only the staging and localhost origins are stripped. The archive is
byte-reproducible — fixed entry mtimes, `zip -X -D`, a sorted entry list — and
its SHA-256 is printed. The packager refuses to ship a host permission it does
not recognize.

Before uploading an update, increment `version` in `manifest.json`; store
package versions must always increase. Pushes and pull requests run the complete
suite in GitHub Actions and publish the store ZIP as a downloadable workflow
artifact, and a matching `v<manifest-version>` tag creates a GitHub Release with
that ZIP attached. Use `npm run version:set -- 0.1.1` to update `manifest.json`,
`package.json`, and the lockfile together. Prepared listing copy, permission
explanations, privacy checks, and reviewer instructions are in
[`docs/chrome-web-store.md`](./docs/chrome-web-store.md).

## Chat behavior

The toolbar icon is the one-click summary path: it captures the whole page and
summarizes it right away, unless that page already has a saved chat — then it
reopens that conversation and spends nothing. Every other capture starts a
turn only when you ask: the panel shows what it captured and waits.

- The empty chat offers one **Summarize** starter, which runs the summary
  pathway against the captured source. Every summary asks for the same thing:
  exactly three one-sentence Markdown bullets, most important first. There is
  no length control — every generation path, summary or ordinary question,
  page, PDF, selection, or video transcript, requests TokenPath's maximum
  output ceiling of 2048 tokens. Generation is billed from the input text, so
  the headroom costs nothing and concision is the prompt's job rather than a
  sentence-cutting cap's. An answer that still reaches the ceiling keeps its
  attribution and carries a note saying it may end abruptly.
- Sources of 24 whitespace-delimited words or fewer are already concise, so the
  summary pathway skips generation and shows an “Already concise” note instead;
  the starter is hidden while that note shows. Whitespace-free CJK prose is
  judged by a character-aware cutoff, so multi-paragraph CJK is not mistaken for
  a one-word selection.
- While an answer streams, the composer stays usable and the submit button
  becomes **Stop**. Stopping cancels the request but keeps the question and
  whatever text had already arrived, marked incomplete. A mid-stream network
  failure keeps the partial answer the same way.
- Each completed answer carries a **Sources (n)** toggle listing every
  attributed phrase — a keyboard path to the same navigation as clicking one.
  Arrow keys move through the list with roving focus, Enter highlights that
  phrase's source, Escape closes the list and returns focus to the toggle.

## How it works

1. Content scripts run from `document_start` in every frame. They snapshot the
   live selection and eagerly extract it on `contextmenu`, before a dynamic page
   such as Gmail, WhatsApp, or Substack can replace or normalize its DOM
   selection. Without a selection they instead build one canonical map of the
   rendered text in the exact frame where the menu opened.
2. The background worker starts an idempotent injection into the exact source
   frame, covering tabs open before an extension reload, then opens the side
   panel without awaiting its animation and captures immediately. Chrome's
   protected PDF viewer cannot accept that injection: after verifying the tab's
   `application/pdf` MIME type, a selected PDF passage uses the exact
   context-menu text, and with no selection the panel downloads the PDF with the
   `<all_urls>` host permission and reads PDFium's full searchable text out of a
   hidden, immediately destroyed Blob copy of the native viewer — the visible PDF
   is never selected or reloaded. Each capture travels as a seed carrying
   `capturedAt` (the click) and `seededAt` (the write); the panel discards a
   seed older than 120 seconds or one whose URL no longer matches the live tab.
3. When a toolbar capture lands on a page with no saved chat, and whenever the
   user asks a question or runs the summary starter, TokenPath streams the
   answer from `POST /v1/generate` using a messages-only request. The
   extension owns the system prompt, exact captured document, bounded
   conversation history, and latest question; TokenPath chooses the inexpensive
   model. Named `delta` events update the panel, while the terminal
   `done.answer` becomes the canonical final text.
4. The panel uses Vercel [AI Elements](https://elements.ai-sdk.dev/)
   conversation, message, and prompt-input primitives; answers render as safe
   Markdown through Streamdown while tokens arrive. After generation, one
   authenticated `POST /v1/attributions/heatmap` request maps the complete
   answer to the captured document. TokenPath's sparse matrix and code-point
   offset tables are validated, converted once to UTF-16, and cached with that
   answer.
5. Clicking an underlined phrase, choosing one from the **Sources** list, or
   selecting any rendered answer text—across Markdown blocks, emphasis, links,
   inline or fenced code, entities, and Unicode—maps back to the exact
   raw-answer character range. A local port of TokenPath's span resolver
   aggregates the cached heatmap just in time and derives one supported source
   range; changing the selection makes no additional API call.
6. The content script maps those document offsets back to live DOM `Range`s,
   highlights the source with the CSS Custom Highlight API, and scrolls it into
   view, including through nested panes such as Gmail's message view. The
   in-page palette has a light and a dark ruleset, chosen per range from the
   measured luminance of the backdrop behind it, so the highlight stays legible
   on a dark page that paints its own background. For a PDF, the background
   worker converts the same resolved range into a contextual `#:~:text=`
   directive; Chrome's native viewer reloads once, then highlights and scrolls
   to that text, preserving ordinary page/zoom anchors. Closing the side panel
   clears the highlight it owns.

PDF capture and attribution require a top-level, text-searchable PDF opened
directly in Chrome's native viewer, at most 50 MiB and 400,000 Unicode
characters. Embedded PDFs, image-only scans, and files the extension cannot
fetch are unsupported. Clicking an attribution reloads the PDF (normally from
cache) because Chrome applies text-fragment highlights only during viewer load,
and each fragment change lands in the tab's Back history.

Full-page HTML capture uses at most the first 400,000 UTF-16 characters of
rendered text in the originating frame. It excludes hidden/script/style text and
keeps visible `user-select: none` content, but cannot include descendant frames,
closed shadow roots, canvas text, form-control values, or content a virtualized
app has not mounted yet.

Attribution survives DOM churn and page refreshes. Where a dynamic page replaces
the target subtree, the resolver searches only beneath the original Gmail or
WhatsApp message, X identity, uniquely headed semantic article, or conservative
generic scope. After a refresh the panel restores the chat from cache and the
reloaded frame — which holds no node map at all — re-resolves each span by
projecting the cached quote and its bounded 48-character contexts into the live
document. Both paths are fail-closed: a changed route, a changed target, or an
ambiguous match reports “Couldn't locate that text in the page.” instead of
jumping to an arbitrary copy. `spec.md` documents the exact rules.

The exact extracted selection, rendered full-page text, or searchable full-PDF
text—plus questions, bounded conversation context, and generated answers—is sent
to TokenPath. DOM nodes, page structure, and the extraction-to-node map remain
inside the source frame.

The panel follows the operating-system theme by default; its header control
switches among system, light, and dark, and the preference stays local. Rejected
keys, rate limits, and insufficient credits (`402`, with a top-up link) are
reported in the chat, and the header shows the remaining token balance. A React
error boundary keeps a rendering failure from emptying the panel, and
informational notices — such as starting a fresh chat because the page changed
significantly — are dismissible status notes rather than errors.

Chats are cached locally per page in IndexedDB (schema v2, which stores each
distinct captured document once per record). The cache key drops URL fragments
and tracking parameters, so a plain `#section` anchor click is scroll position
rather than a new document and the chat survives it. Returning to a page
restores its conversation without an API request; if a fresh capture shows the
content changed significantly, TokenPath starts a new chat and says so.
Retention is bounded to roughly 50 page-chats (least-recently-saved evicted
first) and 30 days. **Clear chat** removes the current page's conversation;
**Disconnect** removes the saved key *and* every cached page chat, since those
records hold captured page text.

## Permissions

`host_permissions` deliberately includes `<all_urls>` — in the unpacked build
and in the store package — alongside `https://api.tokenpath.ai/*`. The declared
`<all_urls>` content script is what snapshots a selection at `contextmenu`
before a dynamic page normalizes it, and what resolves and paints attribution
highlights; it already carries the “read and change all your data on all
websites” install warning. The matching host permission additionally keeps
`tab.url` visible to `tabs.query` and `tabs.onUpdated` outside a user gesture —
per-page chat restore, navigation invalidation, and stale-seed checks all read
it — and covers the side panel's credentialed full-PDF download, which
`activeTab` does not.

Where that data may be sent is constrained separately, in code:
`sidepanel/tokenpath.js` accepts only the exact origins `https://api.tokenpath.ai`,
`https://api-staging.tokenpath.ai`, `http://localhost:8000`, and
`http://127.0.0.1:8000` (a trailing slash is tolerated; a path, query, fragment,
or userinfo is not). Anything else is ignored with a one-time console warning
and the client falls back to production.

## API and local development

The side panel calls TokenPath directly using a key stored in
`chrome.storage.local`. To use a staging or local backend, run this in the panel
DevTools console:

```js
chrome.storage.local.set({ tokenpathBaseUrl: "http://localhost:8000" })
```

Only the four allowlisted origins above are accepted here.

See [`tokenpath-integration.md`](./tokenpath-integration.md) for request shapes
and [`spec.md`](./spec.md) for the extension architecture.

The page-capture scripts remain build-free. The side panel is a React 19,
TypeScript, Tailwind CSS 4, and Vite bundle; AI Elements components are copied
into the repository as editable source. Run the complete validation from
`tldr-extension/`:

```sh
npm install
npm run setup:test # first run on a machine; a no-op outside Debian/Ubuntu
npm test
```

`npm run check` runs the TypeScript typecheck, a `checkJs` pass over the
build-free scripts (`background.js`, `content.js`, `panel-logic.js`,
`tokenpath.js` via `tsconfig.scripts.json`), and the Vite build.

**`sidepanel/panel.js` and `sidepanel/panel.css` are committed build output.**
CI fails if they differ from a fresh build of `src/`, so every change under
`src/sidepanel/` must be committed together with its rebuilt bundle
(`npm run build`).

## Layout

```text
tldr-extension/
├── manifest.json
├── background.js              # frame/page/PDF capture and PDF navigation
├── content.js                 # extraction, node map, remap, highlight
├── content.css                # source attribution highlight (light + dark)
├── package.json               # side-panel build and complete validation
├── vite.config.ts             # local MV3-compatible JS/CSS bundle
├── src/sidepanel/
│   ├── app.tsx                # thin panel shell over the components below
│   ├── controller.ts          # capture/auth/chat/highlight state machine
│   ├── chat-cache.ts          # IndexedDB page-chat store, keys, change check
│   ├── pdf-text-extractor.ts  # hidden native-PDF full-text capture
│   ├── answer-selection.ts    # rendered Markdown → raw-answer offsets
│   ├── hooks/use-answer-highlights.ts
│   ├── lib/                   # answer-highlights (CSS highlights over
│   │                          # attributed phrases), source-copy, utils
│   └── components/
│       ├── panel/             # panel-header, auth-panel, source-card,
│       │                      # composer, answer-response, chat-message,
│       │                      # error-boundary
│       ├── ai-elements/       # adapted Vercel AI Elements source
│       └── ui/                # local shadcn-style primitives
└── sidepanel/
    ├── panel.html
    ├── panel.js               # generated React/AI Elements bundle (committed)
    ├── panel.css              # generated Tailwind/theme bundle (committed)
    ├── panel-logic.js         # summary helpers and heatmap span resolver
    └── tokenpath.js           # streaming generation + heatmap client
```

Test instructions and coverage are in
[`tldr-extension/test/README.md`](./tldr-extension/test/README.md).
