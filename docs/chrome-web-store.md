# Chrome Web Store release

## Prepared listing copy

**Name**

Browse with TokenPath

**Summary**

Chat about a page, PDF, or video, then trace any part of an answer back to its
exact source text.

**Single purpose**

Browse with TokenPath lets users chat with what they are reading or watching,
with every answer traced to its source: the user explicitly captures a web page,
a searchable PDF, a selected passage, or a YouTube video's subtitle transcript,
asks questions about it, and traces the generated answer text back to the
passage that supports it.

**Detailed description**

Browse with TokenPath is a reading assistant that shows its sources.

Ask about any web page, PDF, or captioned YouTube video, then click any part of
the answer to see exactly where it came from, highlighted in the original.

GETTING AN ANSWER

Click the toolbar icon on any page for a short summary in three bullets, with
suggested follow-up questions underneath. On a YouTube watch page, the same
click reads the video's subtitles instead of the page around it, so you can ask
about what was actually said.

To ask about one passage instead of the whole page, select it, right-click, and
choose "Chat with TokenPath". Nothing is generated until you ask.

Return to a page you have already chatted about and your conversation comes
back, with no re-summarizing.

SEEING WHERE IT CAME FROM

Underlined phrases in an answer are traceable. Click one, open the answer's
Sources list, or simply select any words, and the passage that supports it is
highlighted on the page and scrolled into view. In a PDF it highlights the
passage in the document. In a video the player seeks to the moment those words
were spoken. Attribution keeps working after you refresh the page.

YOUR DATA

Nothing is captured until you invoke the extension, so there is no background
collection of your browsing. Conversations are saved locally on your own
machine. Clear chat removes the current page's conversation; Disconnect removes
your saved key and every saved chat at once.

WHAT YOU NEED

A free TokenPath account, which comes with tokens to get you started. The
extension walks you through it the first time you open the panel.

FOR DEVELOPERS

TokenPath is also an API. The same token-level source attribution this extension
uses is available for your own applications at tokenpath.ai.

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
  highlights the attributed source span. On a YouTube watch page the user
  invokes TokenPath on, the same content script reads that video's subtitle
  transcript through YouTube's own same-origin `youtubei/v1/get_panel` endpoint —
  the request the site's built-in transcript panel makes — and later seeks the
  player to an attributed line instead of painting a page highlight.
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
- captured YouTube subtitle transcript text, fetched from YouTube only for a
  watch page the user invoked TokenPath on, and sent to TokenPath as the
  captured document like any other capture;
- the current website origin or URL data sent with a request;
- user questions and generated answers;
- the TokenPath API key stored in `chrome.storage.local` and sent only as
  authentication to TokenPath;
- locally stored page chats: captured page, PDF, or transcript text plus the conversation are
  kept in IndexedDB on the user's machine, capped at roughly 50 pages and 30
  days, and are user-clearable per page (**Clear chat**) or in full
  (**Disconnect**);
- server logging, retention, deletion, and subprocessors;
- that content is captured only after the user invokes TokenPath, not as
  background browsing-history collection.

## Reviewer instructions

The dashboard's test-instructions field caps at 500 characters, so paste the
short version below and keep the full walkthrough here for support replies if a
reviewer asks for more. A TokenPath key is about 66 characters, which the short
version budgets for.

**Dashboard field (465 characters with a real key):**

```text
Test key: <PASTE_REVIEWER_KEY>

Click the TokenPath toolbar icon on any article, then paste the key when prompted. A 3-bullet summary streams. Click an underlined phrase: its source highlights in the page and scrolls into view. Same in a searchable PDF; on a captioned YouTube video the player seeks to that moment. Right-click a selection for our one menu item, which captures only and generates nothing until you ask.
```

**Full walkthrough (reference, not pasted):** ask the reviewer to:

1. Open a normal article and click the TokenPath toolbar icon. The side panel
   opens, shows the captured page, and asks to be connected in two steps —
   create a free account, then create an API key. The supplied reviewer key
   makes both unnecessary; the steps are there for ordinary first-time users.
2. Paste the supplied TokenPath API key into the field under step 2 and
   connect. TokenPath then streams the summary that toolbar click asked for.
   (Nothing is generated while the panel is disconnected, and a page with a
   saved chat reopens that chat instead of summarizing again.)
3. Type any question about the page in the composer. It streams a second
   attributed answer the same way.
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
   only item the extension adds. Confirm the panel now shows *Selected text*,
   generates nothing on its own, and answers about that passage only once you
   ask or click the **Summarize** starter.
10. Open a searchable PDF in Chrome's viewer and repeat steps 3–5 to verify PDF
    capture and highlighting.
11. Open any YouTube video that has captions and click the TokenPath toolbar
    icon. The panel shows that it captured the video transcript and streams a
    summary of what was said. Click one of the underlined phrases in the answer
    and confirm the player seeks to the moment those words were spoken.

There is no other entry point: one context-menu item and the toolbar icon.

## Store assets

- `extension/icons/icon128.png`: packaged extension icon.
- `store-assets/small-promo.png`: 440×280 Chrome Web Store promotional tile.
- `store-assets/screenshots/`: three 1280×800 screenshots of the release build —
  an attributed page summary with its source highlighted, a video-transcript
  capture, and the Settings view. Every page and video in them is invented for
  the shot, so nothing real is published with the listing.

## Release commands

For a normal CI artifact, push a branch or `main`. The **Extension package**
GitHub Actions workflow runs the full test suite, verifies that the committed
side-panel bundle matches `src/`, and publishes a downloadable ZIP artifact for
30 days. The live third-party site checks are not part of that run: they execute
on the nightly schedule, or on demand through the workflow's `live_sites` input.
The nightly job and the release job are gated on
`github.repository == 'tokenpath/browse-with-tokenpath'`, so a fork inherits the
tests but neither the cron traffic against third-party sites nor the ability to
cut a release.

For a versioned GitHub release:

```sh
cd extension
npm run version:set -- 0.1.1
npm run licenses
cd ..
git add extension/manifest.json extension/package.json \
  extension/package-lock.json THIRD-PARTY-LICENSES.md
git commit -m "Release extension v0.1.1"
git tag v0.1.1
git push origin main v0.1.1
```

Stage the files by name. `git add .` in a repository this size is how an
untracked local artifact — a scratch capture, a downloaded PDF, an `.env` —
reaches a public release commit, and `.gitignore` only covers what someone
thought of first.

The tag must exactly match the version in `manifest.json`. A valid tag creates
a GitHub Release with the Chrome Web Store ZIP attached.

For a local package:

```sh
cd extension
npm run package:store
```

The ZIP carries `THIRD-PARTY-LICENSES.md` at its root: the side-panel bundle is
minified, which strips the license headers its dependencies require to travel
with the code, so the notice ships in the package instead. Regenerate it with
`npm run licenses` after any dependency change — CI regenerates and diffs, so a
stale notice fails the build.

The packaged `manifest.json` declares exactly two host permissions,
`<all_urls>` and `https://api.tokenpath.ai/*`; only the staging and localhost
development origins are stripped, and the packager fails loudly on any host
permission it does not recognize. The ZIP is byte-reproducible and its SHA-256
is printed, so the uploaded artifact can be re-derived from the same commit.

Upload `dist/browse-with-tokenpath-<version>.zip` in the Chrome Web
Store Developer Dashboard.
