# Chrome Web Store release

## Prepared listing copy

**Name**

TokenPath — Chat with Attribution

**Summary**

Chat about a page or PDF, then trace any part of an answer back to its exact
source text.

**Single purpose**

TokenPath lets users ask questions about webpage or PDF text they explicitly
capture, then trace generated answer text back to the passage that supports it.

**Detailed description**

TokenPath adds an attributed chat to webpages and searchable PDFs.

Click the TokenPath toolbar icon to chat about the page you are on, or select a
passage, right-click, and choose **Chat with TokenPath** to chat about just that
text. Nothing is generated automatically: the panel shows what it captured and
waits. Type your question, or use the one-click **Summarize** starter, which
answers with three short bullet points you can follow up on.

After TokenPath answers, click any underlined phrase — or open the answer's
**Sources** list, or select any words in the answer. The extension maps that
span back to the strongest supporting passage, highlights it on the page, and
scrolls it into view.

Chats are saved locally per page, so returning to a page brings its conversation
back, and attribution keeps working after a refresh. **Clear chat** removes the
current page's saved chat; **Disconnect** removes the saved key and every locally
saved chat.

The extension uses one TokenPath API key for streaming generation and
token-level source attribution.

## Permission explanations

- **contextMenus**: Adds the single **Chat with TokenPath** item the user clicks
  to capture a selection, page, or frame.
- **sidePanel**: Displays the attributed chat beside the current page.
- **activeTab**: Accesses the clicked tab when the user invokes TokenPath.
- **scripting**: Restores capture support on an already-open page when needed,
  and probes whether the tab is Chrome's native PDF viewer.
- **storage**: Stores the TokenPath API key and UI preferences locally.
- **All website content scripts (`<all_urls>` content script)**: Captures a live
  user selection before a dynamic page replaces it, and later resolves and
  highlights the attributed source span.
- **`<all_urls>` host permission**: The content script above already grants the
  “read and change all your data on all websites” access this warning describes.
  The matching host permission is what additionally keeps `tab.url` readable
  outside a user gesture (`tabs.query` / `tabs.onUpdated`), which the extension
  uses to restore the right page's saved chat, to notice that the tab navigated
  away from the captured document, and to reject a stale capture. It also
  authorizes the side panel's credentialed download of a PDF the user asked to
  read in full, which `activeTab` does not cover.
- **api.tokenpath.ai**: Sends user-invoked content for generation and
  attribution. The extension's network client hard-codes an allowlist of
  accepted API origins, so captured text and the API key cannot be redirected to
  another host.

## Privacy declarations to verify

The dashboard declarations and public privacy policy must match production
behavior. Confirm and disclose:

- captured webpage or PDF text;
- the current website origin or URL data sent with a request;
- user questions and generated answers;
- the TokenPath API key stored in `chrome.storage.local` and sent only as
  authentication to TokenPath;
- locally stored page chats: captured page or PDF text plus the conversation are
  kept in IndexedDB on the user's machine, capped at roughly 50 pages and 30
  days, and are user-clearable per page (**Clear chat**) or in full
  (**Disconnect**);
- server logging, retention, deletion, and subprocessors;
- that content is captured only after the user invokes TokenPath, not as
  background browsing-history collection.

## Reviewer instructions

Provide a temporary reviewer API key, then ask the reviewer to:

1. Open a normal article and click the TokenPath toolbar icon. The side panel
   opens with an empty chat.
2. Paste the supplied TokenPath API key and connect.
3. Click the **Summarize** starter in the empty chat. TokenPath reads the page,
   then streams a summary. (Any typed question works the same way. Nothing is
   generated until this step — capture alone never starts an answer.)
4. Wait for “Mapping this answer to the source…” to finish. Attributed phrases
   in the answer become underlined.
5. Click one of the underlined phrases. Confirm that the matching text is
   highlighted in the page and scrolled into view.
6. Open the **Sources (n)** control beneath the answer, move through the list
   with the arrow keys, and press Enter. Confirm the same highlighting behavior
   from the keyboard.
7. Select any words inside the answer with the mouse to confirm the third path
   to the same attribution.
8. Reload the article. The chat is restored; clicking a phrase again still
   highlights the source in the reloaded page.
9. Select one paragraph, right-click, and choose **Chat with TokenPath** — the
   only item the extension adds. Confirm the panel now shows *Selected text* and
   answers about that passage only.
10. Open a searchable PDF in Chrome's viewer and repeat steps 3–5 to verify PDF
    capture and highlighting.

There is no other entry point: one context-menu item and the toolbar icon.

## Store assets

- `tldr-extension/icons/icon128.png`: packaged extension icon.
- `store-assets/small-promo.png`: 440×280 Chrome Web Store promotional tile.
- Still required: at least one real 1280×800 or 640×400 screenshot captured
  from the release build.

## Release commands

For a normal CI artifact, push a branch or `main`. The **Extension package**
GitHub Actions workflow runs the full test suite, verifies that the committed
side-panel bundle matches `src/`, and publishes a downloadable ZIP artifact for
30 days. The live third-party site checks are not part of that run: they execute
on the nightly schedule, or on demand through the workflow's `live_sites` input.

For a versioned GitHub release:

```sh
cd tldr-extension
npm run version:set -- 0.1.1
cd ..
git add .
git commit -m "Release extension v0.1.1"
git tag v0.1.1
git push origin main v0.1.1
```

The tag must exactly match the version in `manifest.json`. A valid tag creates
a GitHub Release with the Chrome Web Store ZIP attached.

For a local package:

```sh
cd tldr-extension
npm run package:store
```

The packaged `manifest.json` declares exactly two host permissions,
`<all_urls>` and `https://api.tokenpath.ai/*`; only the staging and localhost
development origins are stripped, and the packager fails loudly on any host
permission it does not recognize. The ZIP is byte-reproducible and its SHA-256
is printed, so the uploaded artifact can be re-derived from the same commit.

Upload `dist/tokenpath-chat-with-attribution-<version>.zip` in the Chrome Web
Store Developer Dashboard.
