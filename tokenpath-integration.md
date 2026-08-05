# Generation and Attribution in Browse with TokenPath

> **Status (2026-07): live single-provider implementation.** TokenPath streams
> generation from a messages-only `/v1/generate` request, then receives the
> final answer once and returns a reusable attribution heatmap. One TokenPath
> key covers the complete flow.

## Current request flow

The side panel is an extension page, so declared host permissions let it call
TokenPath without a proxy backend. The API key lives in `chrome.storage.local`.

The extension uses three requests:

1. `GET https://api.tokenpath.ai/v1/me/credits` validates the TokenPath key and
   refreshes the displayed balance.
2. `POST https://api.tokenpath.ai/v1/generate` streams one answer.
3. `POST https://api.tokenpath.ai/v1/attributions/heatmap` attributes that exact
   final displayed answer once.

The heatmap is cached with its assistant message. Selecting any span in the
rendered answer aggregates the matrix locally and routes the resulting document
character bounds to the source frame. A second answer selection does not make a
second TokenPath request.

## Authentication and errors

Requests receive the TokenPath bearer token:

```http
Authorization: Bearer <provider key>
Content-Type: application/json
```

The extension handles rejected keys (`401`/`403`), insufficient credits (`402`),
rate limits (`429`), network failures, cancellation, invalid responses, and
90-second idle or request timeouts. A generation error is shown as an assistant
error message. A heatmap error leaves the generated answer visible and marks
only its source map unavailable.

TokenPath defaults to `https://api.tokenpath.ai`. For staging or local
development, set `tokenpathBaseUrl` in extension storage:

```js
chrome.storage.local.set({ tokenpathBaseUrl: "http://localhost:8000" })
```

That value is a developer convenience, not a routing instruction: every request
carries the API key and the complete captured page text, so `tokenpath.js`
accepts only these exact origins and ignores anything else, falling back to
production with a one-time console warning.

| Allowed base URL |
|---|
| `https://api.tokenpath.ai` (default) |
| `https://api-staging.tokenpath.ai` |
| `http://localhost:8000` |
| `http://127.0.0.1:8000` |

A trailing slash is tolerated. A path, query string, fragment, or userinfo is
not — the value must be a bare origin from the list. The staging and localhost
origins are also the only host permissions the store package drops, so this
override is usable in an unpacked build only.

## TokenPath generation

Generation uses:

```http
POST https://api.tokenpath.ai/v1/generate
Accept: text/event-stream
Content-Type: application/json
```

The request is deliberately messages-only apart from its output ceiling:

```json
{
  "max_output_tokens": 2048,
  "messages": [
    {
      "role": "system",
      "content": "Website origin, Markdown formatting guidance, and the exact selected document"
    },
    {
      "role": "user",
      "content": "The latest question"
    }
  ]
}
```

The system message identifies the website origin, asks the model to answer the
user's question, and requests concise Markdown with bullets or tables only when
they improve readability. Bounded prior user and assistant turns sit between
the system message and latest question.

The API accepts 1–50 messages, requires the last role to be `user`, caps total
message content at 420,000 characters, and accepts `max_output_tokens` from 16
through 2048. The controller keeps the exact document as large as possible,
then packs recent history backward within both caps. Generation is billed from
all submitted message content; the returned `billed_tokens` and
`credits_remaining` update the panel without an extra balance request.

TokenPath selects the inexpensive model and adds no prompt of its own. The
response uses named server-sent events:

```text
event: delta
data: {"text":"partial answer"}

event: done
data: {"answer":"canonical complete answer","model":"...","usage":{"input_tokens":42,"output_tokens":10,"billed_tokens":37},"credits_remaining":9999963}
```

The client parses events incrementally, including names and JSON split across
network chunks or UTF-8 byte boundaries. It updates one stable assistant
message from `delta.text`, then uses `done.answer` as the canonical final
string. A terminal `error` event carries the normal TokenPath error envelope.
A new capture, navigation, or disconnect cancels in-flight generation.

Generation is only ever started by a user action — a submitted question or the
panel's **Summarize** starter. A capture by itself makes no request.

For the summary pathway, sources of 24 words or fewer make no request at all
(CJK-dominant text uses a 48-character cutoff); the panel posts an “Already
concise” note instead. Every longer source gets one of two prompts — the
default asking for exactly 3 one-sentence Markdown bullet points, most
important first, or a Detailed one asking for a structured summary in sections
— or the user's own instructions in place of either. All three share the same
suffix and the same `max_output_tokens: 2048`. That ceiling is TokenPath's maximum and is what
every generation path sends — summaries and ordinary questions alike — because
generation is billed from the input text, so a lower ceiling saves nothing and
only risks stopping mid-sentence. The ceiling leaves completion headroom;
prompt wording controls the intended length. An answer that produces every
token it was allowed gets a note saying it reached the maximum answer length,
and stays attributed. The client does not clip or replace the result: the exact
terminal
`done.answer` is used for the UI, conversation history, and heatmap request.

### The suggestions tail

When follow-up suggestions are enabled, the panel appends one fixed instruction
after the latest question in the **outgoing user message only**, asking the
model to end its answer with a block of four Q/A pairs:

```text
<<<SUGGESTIONS
Q: <question strictly answerable from the provided text, about material not already covered by this answer>
A: "<verbatim quote of at most 10 words from the provided text that the answer to this question would cite>"
Q: ...
A: "..."
SUGGESTIONS>>>
```

This is a client-side convention, not a TokenPath feature: `/v1/generate` is
unchanged and TokenPath adds no prompt of its own. Riding along on the answer's
own call is what makes it free — generation is billed from the input text, so a
separate request would re-pay for the whole document to obtain two questions,
while the extra output tokens cost nothing.

The block therefore appears in `done.answer` (and in the trailing `delta`
events). **The panel strips it before anything else sees the answer.** Every
complete block, a stray closing marker, and an opener the stream never closed
are removed from each streaming delta and from the terminal answer, so:

- the rendered answer never shows the marker, not even mid-stream;
- `POST /v1/attributions/heatmap` receives the stripped answer — the block is
  never part of the `answer` field, and the heatmap therefore never maps it;
- the conversation history and the cached page chat store the stripped answer;
  and
- the `question` field of the heatmap request is the question **without** the
  tail, because the tail is added to the outgoing message only.

An answer that carries no block is passed through byte for byte. A malformed
block yields no suggestions and never garbles the answer. The panel then keeps
only candidates whose anchor quote occurs verbatim in the captured document and
whose anchors lie outside the regions the answer's heatmap drew on, and shows at
most two.

Cancellation is not always discarding. Navigation, a newer capture, or
disconnect drops the turn, but the composer's **Stop** button and a mid-stream
network failure both keep the partial answer, flagged incomplete. Neither sends
a heatmap request for it: attributing an unfinished answer would map text the
model never produced.

## TokenPath heatmap

The client sends:

```http
POST /v1/attributions/heatmap
```

```json
{
  "document": "the exact canonical extracted source",
  "question": "the latest user turn",
  "answer": "the exact final displayed answer"
}
```

An optional `threshold` from `0` through `1` is supported by the client, though
the panel currently uses the service default. The expected response is a sparse
COO matrix plus token offset tables:

```json
{
  "row": [0, 0, 1],
  "col": [4, 5, 7],
  "data": [0.82, 0.31, 0.64],
  "shape": [2, 10],
  "answer_offsets": [[0, 5], [6, 12]],
  "document_offsets": [[0, 3], [4, 8], [9, 13]]
}
```

`shape[0]` is the answer-token count and `shape[1]` is the document-token count.
Each `data[i]` connects answer token `row[i]` to document token `col[i]`.
Offsets are half-open Unicode code-point bounds against the exact submitted
strings, not JavaScript UTF-16 code units.

The adapter verifies:

- a positive two-dimensional shape;
- equal `row`, `col`, and `data` lengths;
- in-range integer token indices;
- finite scores from `0` through `1`; and
- offset-table lengths and in-range half-open character bounds.

It then converts both complete offset tables to UTF-16 once. All rendered-answer
mapping, heatmap aggregation, extraction-map indexing, and DOM `Range`
boundaries are JavaScript-native after that point, including text following
emoji or other astral-plane characters.

## Local selection-to-source resolution

Rendered Markdown cannot be indexed directly because delimiters, entities,
hidden destinations, and block structure alter its DOM text.
`answer-selection.ts` builds a source-positioned visible-text map from the same
GFM, then aligns selected Streamdown text nodes to it. This returns the exact raw
UTF-16 range while excluding hidden link URLs and image metadata, and handles
repeated phrases plus selections crossing emphasis, selectable links, inline or
fenced code, decoded entities, and blocks.

`panel-logic.js` mirrors the TokenPath service resolver for that answer range:

1. Select every overlapping answer token.
2. Sum its positive attribution mass for each document token.
3. Choose the peak document token.
4. Grow left and right across tokens carrying at least 25% of the peak,
   bridging no more than three weaker tokens.
5. Convert that token interval to document character bounds.
6. Snap outward over adjacent alphanumeric characters.
7. When the selected answer text occurs verbatim in the document, snap only to
   an occurrence overlapping the attention-derived interval and choose the
   nearest center.

The last rule preserves occurrence-level disambiguation when text such as
`Fable 5` appears more than once. It never replaces the heatmap with an
unconstrained first-string match.

The same cached heatmap also drives the answer's phrase list: `panel-logic.js`
derives every attributed phrase from it, the panel underlines them in the
rendered answer, and the **Sources (n)** control lists them for keyboard use.
Clicking a phrase, activating a list entry, and selecting answer text all run
the resolution above against the one cached matrix — no additional request in
any case.

## Capture and source navigation

The originating `tabId`, `frameId`, and `captureId` are preserved from capture
through generation, heatmap caching, and highlight routing. The immutable
attribution artifact also retains the exact canonical document and question
used for that answer, and is what a restored page-chat replays: cached chats
keep each distinct document once per record and reference it from the answers
attributed against it, so reopening a page needs no TokenPath request at all.

Once a source range is resolved, the existing content-script machinery maps its
canonical document offsets to live DOM nodes. If those nodes were replaced, it
searches only inside the original Gmail or WhatsApp message, X
post/status/article identity, uniquely headed semantic article, or conservative
generic scope. Context and exact source identity disambiguate repeats. Changed
routes, changed target text, surviving duplicates, and ambiguous matches fail
instead of highlighting an arbitrary occurrence.

Because the highlight message carries the cached canonical document, a frame
that reloaded since the answer was attributed can still recover: it re-derives
the quote and its bounded surrounding context from that document and locates
them in the fresh DOM. The same fail-closed rules apply, so a genuinely changed
or vanished passage reports a failure rather than moving the highlight.

Each navigation request also carries an opaque highlight ownership ID. Cleanup
from an older answer selection can only remove the highlight it created, so
rapid selections cannot let a delayed response clear the newer result.

## Data and privacy

TokenPath receives the exact extracted selection, rendered full-page text, or
searchable full-PDF text, plus the latest question, bounded conversation text,
and generated answer. Generation receives them in messages; the heatmap request
receives the bare document, question, and canonical answer.

TokenPath does not receive DOM nodes, page structure, the extraction-to-node
map, or the user's native browser selection object.

## Separation of concerns

`/v1/generate` returns plain answer text with no citations, marker syntax, or
attribution spans. `/v1/attributions/heatmap` remains a separate,
model-independent call. The old bundled `/v1/answer` flow and backend-selected
fixed answer spans are not part of this architecture.
