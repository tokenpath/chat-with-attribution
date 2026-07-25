# Generation and TokenPath Integration for TLDR

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
  "max_output_tokens": 512,
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

Selections of 24 words or fewer skip automatic generation; whitespace-free CJK
uses a 48-character cutoff. Longer selections use a persisted client-side
length preference: Low requests about 2–3 sentences with
`max_output_tokens: 512`, Medium requests 4–6 with `768`, and High requests
8–12 with `1024`. The ceilings leave completion headroom; prompt wording
controls the intended length. The client does not clip or replace the result:
the exact terminal `done.answer` is used for the UI, conversation history, and
heatmap request.

## TokenPath heatmap

The client sends:

```http
POST /v1/attributions/heatmap
```

```json
{
  "document": "the exact canonical extracted selection",
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

## Capture and source navigation

The originating `tabId`, `frameId`, and `captureId` are preserved from context
menu through generation, heatmap caching, and highlight routing. The immutable
attribution artifact also retains the exact canonical document and question
used for that answer.

Once a source range is resolved, the existing content-script machinery maps its
canonical document offsets to live DOM nodes. If those nodes were replaced, it
searches only inside the original Gmail or WhatsApp message, X
post/status/article identity, uniquely headed semantic article, or conservative
generic scope. Context and exact source identity disambiguate repeats. Changed
routes, changed target text, surviving duplicates, and ambiguous matches fail
instead of highlighting an arbitrary occurrence.

Each navigation request also carries an opaque highlight ownership ID. Cleanup
from an older answer selection can only remove the highlight it created, so
rapid selections cannot let a delayed response clear the newer result.

## Data and privacy

TokenPath receives the exact extracted selection, latest question, bounded
conversation text, and generated answer. Generation receives them in messages;
the heatmap request receives the bare document, question, and canonical answer.

TokenPath does not receive DOM nodes, page structure, unrelated page text, the
extraction-to-node map, or the user's native browser selection object.

## Separation of concerns

`/v1/generate` returns plain answer text with no citations, marker syntax, or
attribution spans. `/v1/attributions/heatmap` remains a separate,
model-independent call. The old bundled `/v1/answer` flow and backend-selected
fixed answer spans are not part of this architecture.
