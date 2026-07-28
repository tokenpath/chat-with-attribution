# Chrome Web Store release

## Prepared listing copy

**Name**

TokenPath — Chat with Attribution

**Summary**

Summarize, simplify, or ask about pages and PDFs, then trace any answer text
back to its exact source.

**Single purpose**

TokenPath lets users summarize, simplify, and ask questions about webpage or
PDF text they explicitly invoke, then trace generated answer text back to its
supporting source.

**Detailed description**

TokenPath adds an attributed chat to webpages and searchable PDFs.

Right-click selected text—or invoke TokenPath without a selection to use the
full page or PDF—then choose:

- TLDR for a concise summary
- Simplify for a plain-language explanation
- Ask a question to open an attributed chat

After TokenPath answers, select any words in the answer. The extension maps
that span back to the strongest supporting passage, highlights it on the page,
and scrolls it into view.

The extension uses one TokenPath API key for streaming generation and
token-level source attribution.

## Permission explanations

- **contextMenus**: Starts an explicit TLDR, Simplify, or Ask a question action.
- **sidePanel**: Displays the attributed chat beside the current page.
- **activeTab**: Accesses the tab only when the user invokes TokenPath.
- **scripting**: Restores capture support on an already-open page when needed.
- **storage**: Stores the TokenPath API key and UI preferences locally.
- **All website content scripts**: Captures a live user selection before a
  dynamic page replaces it, and later highlights an attributed source span.
- **api.tokenpath.ai**: Sends user-invoked content for generation and
  attribution.

## Privacy declarations to verify

The dashboard declarations and public privacy policy must match production
behavior. Confirm and disclose:

- captured webpage or PDF text;
- the current website origin or URL data sent with a request;
- user questions and generated answers;
- the TokenPath API key stored in `chrome.storage.local` and sent only as
  authentication to TokenPath;
- server logging, retention, deletion, and subprocessors;
- that content is captured only after a TokenPath action, not as background
  browsing-history collection.

## Reviewer instructions

Provide a temporary reviewer API key, then ask the reviewer to:

1. Open a normal article and select a paragraph.
2. Right-click and choose **TokenPath → TLDR**.
3. Connect with the supplied TokenPath API key.
4. Wait for the summary and source map.
5. Select a phrase in the answer.
6. Confirm that TokenPath highlights and scrolls to supporting page text.
7. Repeat without a page selection to verify full-page capture.
8. Open a searchable PDF and repeat to verify PDF support.

## Store assets

- `tldr-extension/icons/icon128.png`: packaged extension icon.
- `store-assets/small-promo.png`: 440×280 Chrome Web Store promotional tile.
- Still required: at least one real 1280×800 or 640×400 screenshot captured
  from the release build.

## Release commands

For a normal CI artifact, push a branch or `main`. The **Extension package**
GitHub Actions workflow runs the full test suite and publishes a downloadable
ZIP artifact for 30 days.

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

Upload `dist/tokenpath-chat-with-attribution-<version>.zip` in the Chrome Web
Store Developer Dashboard.
