// Isolated test of the pure offset logic that lives in content.js.
// Simulates: extraction string + node map -> stub attributions -> highlight
// resolution, asserting the source span resolves to correct raw node offsets.
//
// content.js itself is evaluated here, and the helpers under test come from
// its `__tldrTestHooks` export, so these assertions can never drift from the
// code that runs on a page.

const assert = require("assert");
const { readFileSync } = require("fs");
const { join } = require("path");
const vm = require("vm");

const source = readFileSync(join(__dirname, "..", "content.js"), "utf8");

// The content script only exports its helpers when a harness has already
// created the hook object. `withHooks: false` proves it stays inert on a page.
function loadContentScript(withHooks = true) {
  const ranges = [];
  const sandbox = {
    CSS: { highlights: new Map() },
    Node: { ELEMENT_NODE: 1, TEXT_NODE: 3 },
    NodeFilter: {
      SHOW_TEXT: 4,
      FILTER_ACCEPT: 1,
      FILTER_REJECT: 2,
    },
    chrome: { runtime: { onMessage: { addListener() {} } } },
    console: { log() {}, warn() {}, error() {} },
    document: {
      addEventListener() {},
      body: null,
      documentElement: null,
      createRange() {
        const range = {
          setStart(node, offset) {
            range.startContainer = node;
            range.startOffset = offset;
          },
          setEnd(node, offset) {
            range.endContainer = node;
            range.endOffset = offset;
          },
        };
        ranges.push(range);
        return range;
      },
    },
    location: {
      hash: "",
      hostname: "example.com",
      href: "https://example.com/article",
      origin: "https://example.com",
      pathname: "/article",
      search: "",
    },
    window: {
      getSelection: () => null,
      // Elements in these tests carry their own computed style.
      getComputedStyle: (element) =>
        element?.style || { backgroundColor: "rgba(0, 0, 0, 0)" },
    },
  };
  if (withHooks) sandbox.__tldrTestHooks = {};
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: "content.js" });
  return { hooks: sandbox.__tldrTestHooks, sandbox, ranges };
}

const { hooks, sandbox } = loadContentScript();
for (const name of [
  "buildQuoteProjection",
  "chooseQuoteMatch",
  "clampSpan",
  "findEntry",
  "firstEntryAtOrAfter",
  "hasDarkBackdrop",
  "isWs",
  "lastEntryAtOrBefore",
  "makeDocumentQuoteSelector",
  "normalizeSlice",
  "resolveRangeFromMap",
]) {
  assert.strictEqual(
    typeof hooks[name],
    "function",
    `content.js exports ${name} to the test harness`
  );
}
assert.strictEqual(
  loadContentScript(false).hooks,
  undefined,
  "content.js exports nothing on a page that never created the hook object"
);
console.log("PASS: content.js exports its pure helpers only to the harness");

// resolve a source [start,end) the way content.js highlightRange does, then
// read the resulting range back through the map's raw offsets.
function resolve(text, map, rawStart, rawEnd) {
  const { start, end } = hooks.clampSpan(text, rawStart, rawEnd);
  if (end <= start) return null;
  const resolved = hooks.resolveRangeFromMap(map, start, end);
  if (!resolved) return null;
  const { range, startEntry, endEntry } = resolved;
  const canonicalStart =
    startEntry.start + startEntry.rawOffsets.indexOf(range.startOffset);
  const canonicalEnd =
    endEntry.start + endEntry.rawOffsets.indexOf(range.endOffset - 1) + 1;
  return {
    startEntry,
    endEntry,
    nodeStart: range.startOffset,
    nodeEnd: range.endOffset,
    snappedText: text.slice(canonicalStart, canonicalEnd),
  };
}

// stub attribution logic (mirror of askLLM)
function stubAttribs(context) {
  const blocks = [];
  let cursor = 0;
  for (const raw of context.split("\n")) {
    const leading = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (trimmed) blocks.push({ text: trimmed, start: cursor + leading });
    cursor += raw.length + 1;
  }
  const out = [];
  for (const block of blocks.slice(0, 6)) {
    const m = block.text.match(/^[\s\S]*?[.!?](?=\s|$)/);
    const sentence = m ? m[0] : block.text;
    out.push({ sourceStart: block.start, sourceEnd: block.start + sentence.length, sentence });
  }
  return out;
}

// --- build a fake extraction: a heading (no period) + a paragraph ---
// Each map entry maps 1:1 here (no whitespace collapse), rawOffsets[i] = start+i
// but we deliberately give nodes DIFFERENT base rawOffsets to catch off-by-one.
function makeEntry(node, start, str, rawBase) {
  const rawOffsets = [];
  for (let i = 0; i < str.length; i++) rawOffsets.push(rawBase + i);
  return { start, end: start + str.length, node, rawOffsets };
}

const heading = "About the Project"; // no sentence terminator
const para = "This is the first sentence. And a second one.";
const text = heading + "\n" + para;

const map = [
  makeEntry({ id: "h", isConnected: true }, 0, heading, 100),
  // note the "\n" at index heading.length is synthetic — NOT in the map
  makeEntry({ id: "p", isConnected: true }, heading.length + 1, para, 500),
];

// 1) stub attributions have exact source slices
const attribs = stubAttribs(text);
assert.strictEqual(attribs.length, 2, "two blocks");
assert.strictEqual(text.slice(attribs[0].sourceStart, attribs[0].sourceEnd), "About the Project");
assert.strictEqual(text.slice(attribs[1].sourceStart, attribs[1].sourceEnd), "This is the first sentence.");
console.log("PASS: stub source offsets slice exactly");

// 2) heading attribution resolves (this was the bug: snapped onto "\n")
const rH = resolve(text, map, attribs[0].sourceStart, attribs[0].sourceEnd);
assert.ok(rH, "heading resolves");
assert.strictEqual(rH.startEntry.node.id, "h");
assert.strictEqual(rH.endEntry.node.id, "h");
assert.strictEqual(rH.nodeStart, 100, "heading raw start");
assert.strictEqual(rH.nodeEnd, 100 + heading.length, "heading raw end excludes newline");
assert.strictEqual(rH.snappedText, "About the Project");
console.log("PASS: heading (no period) resolves and excludes the \\n separator");

// 3) paragraph first-sentence resolves into the second node
const rP = resolve(text, map, attribs[1].sourceStart, attribs[1].sourceEnd);
assert.ok(rP, "para resolves");
assert.strictEqual(rP.startEntry.node.id, "p");
assert.strictEqual(rP.nodeStart, 500, "para raw start");
assert.strictEqual(rP.snappedText, "This is the first sentence.");
console.log("PASS: paragraph sentence resolves into correct node with correct raw offsets");

// 4) a range that starts right on the newline gap still clamps to real text
const gap = heading.length; // index of "\n"
const rGap = resolve(text, map, gap, gap + 5);
assert.ok(rGap, "gap-adjacent range resolves");
assert.strictEqual(rGap.startEntry.node.id, "p");
assert.strictEqual(rGap.nodeStart, 500, "the separator clamps onto the next node");
console.log("PASS: range touching the separator gap clamps to a real entry");

// 5) sub-sentence spans stay exact — no sentence expansion. TokenPath returns
// character-perfect source spans; the client must not blur them.
const word = "first sentence";
const wordStart = text.indexOf(word);
const rWord = resolve(text, map, wordStart, wordStart + word.length);
assert.ok(rWord, "sub-sentence span resolves");
assert.strictEqual(rWord.snappedText, word, "span is not expanded to the sentence");
assert.strictEqual(rWord.nodeStart, 500 + (wordStart - (heading.length + 1)));
console.log("PASS: sub-sentence spans highlight exactly, with no sentence snapping");

// 6) clampSpan trims Unicode whitespace and rejects non-finite bounds.
// The helpers build objects inside the vm context, so compare own properties
// rather than prototypes.
const clamp = (...args) => ({ ...hooks.clampSpan(...args) });
assert.deepStrictEqual(clamp("  hi  ", 0, 6), { start: 2, end: 4 });
assert.deepStrictEqual(clamp("a b", 1, 2), { start: 2, end: 2 });
assert.deepStrictEqual(clamp("abc", -5, 99), { start: 0, end: 3 });
assert.deepStrictEqual(clamp("abc", NaN, 2), { start: 0, end: 0 });
assert.strictEqual(hooks.isWs(" "), true);
assert.strictEqual(hooks.isWs("a"), false);

// 7) entry lookup covers hits, separator gaps, and out-of-range offsets
assert.strictEqual(hooks.findEntry(map, 0), map[0]);
assert.strictEqual(hooks.findEntry(map, heading.length), null, "the separator has no entry");
assert.strictEqual(hooks.findEntry(map, text.length), null);
assert.strictEqual(hooks.firstEntryAtOrAfter(map, heading.length), map[1]);
assert.strictEqual(hooks.lastEntryAtOrBefore(map, heading.length), map[0]);
assert.strictEqual(hooks.firstEntryAtOrAfter(map, text.length), null);

// 8) whitespace collapse keeps every emitted character's raw source offset
const rawNode = "  Two\n\n words\t";
const collapsed = hooks.normalizeSlice(rawNode, 0, rawNode.length);
assert.strictEqual(collapsed.out, " Two words ");
assert.strictEqual(collapsed.out.length, collapsed.rawOffsets.length);
for (let i = 0; i < collapsed.out.length; i++) {
  const raw = rawNode[collapsed.rawOffsets[i]];
  assert.strictEqual(
    hooks.isWs(collapsed.out[i]) ? hooks.isWs(raw) : raw,
    hooks.isWs(collapsed.out[i]) ? true : collapsed.out[i],
    `offset ${i} points back at its source character`
  );
}

// 9) a detached node can never produce a live Range
const detachedMap = [makeEntry({ id: "d", isConnected: false }, 0, heading, 100)];
assert.strictEqual(hooks.resolveRangeFromMap(detachedMap, 0, 5), null);
console.log("PASS: real clamp/lookup/normalize helpers round-trip their offsets");

// 10) the highlight palette follows the backdrop actually painted behind the
// attributed text, not the page's declared colour scheme.
function backdropRange(backgrounds) {
  let element = null;
  for (const backgroundColor of backgrounds) {
    element = { style: { backgroundColor }, parentElement: element };
  }
  return { startContainer: { nodeType: 3, parentElement: element } };
}

const transparent = "rgba(0, 0, 0, 0)";
sandbox.document.body = { style: { backgroundColor: "rgb(255, 255, 255)" } };
sandbox.document.documentElement = { style: { backgroundColor: transparent } };

// Nearest opaque ancestor wins, in either direction.
assert.strictEqual(
  hooks.hasDarkBackdrop(backdropRange(["rgb(255, 255, 255)", transparent])),
  false
);
assert.strictEqual(
  hooks.hasDarkBackdrop(backdropRange(["rgb(255, 255, 255)", "rgb(32, 33, 36)"])),
  true,
  "Gmail's dark message pane overrides the white page behind it"
);
assert.strictEqual(
  hooks.hasDarkBackdrop(backdropRange(["rgb(0, 0, 0)", "rgb(247, 249, 249)"])),
  false
);
// A translucent overlay is not the effective backdrop.
assert.strictEqual(
  hooks.hasDarkBackdrop(backdropRange(["rgb(21, 32, 43)", "rgba(255, 255, 255, 0.1)"])),
  true
);
// Nothing opaque above the text: fall back to the document canvas.
assert.strictEqual(hooks.hasDarkBackdrop(backdropRange([transparent])), false);
sandbox.document.body = { style: { backgroundColor: "rgb(0, 0, 0)" } };
assert.strictEqual(hooks.hasDarkBackdrop(backdropRange([transparent])), true);
// An unparseable or missing style must never break highlighting.
sandbox.document.body = null;
sandbox.document.documentElement = null;
assert.strictEqual(hooks.hasDarkBackdrop(backdropRange(["color(srgb 0 0 0)"])), false);
assert.strictEqual(hooks.hasDarkBackdrop({ startContainer: null }), false);
console.log("PASS: dark backdrops select the dark highlight palette");

// Values built inside the vm context carry that context's prototypes, which a
// strict deep comparison would reject on identity alone.
const plain = (value) => JSON.parse(JSON.stringify(value));

// 11) After a page reload the node map is gone and the cached source document
// is the only record of the attributed text. Its projection has to line up
// character for character with a live extraction's projection, or a recovered
// quote could never match.
const blocks = [
  "Kettle physics",
  "Water boils at 100 C.",
  "Altitude lowers it.",
];
const documentText = blocks.join("\n");
const liveMap = [];
for (let cursor = 0, i = 0; i < blocks.length; i++) {
  liveMap.push({ start: cursor, end: cursor + blocks[i].length });
  cursor += blocks[i].length + 1;
}
const liveProjection = hooks.buildQuoteProjection(documentText, liveMap);
const cachedProjection = hooks.buildQuoteProjection(documentText, [
  { start: 0, end: documentText.length },
]);
assert.strictEqual(
  liveProjection.text,
  "Kettle physics Water boils at 100 C. Altitude lowers it.",
  "synthetic block separators project as single spaces"
);
assert.strictEqual(
  cachedProjection.text,
  liveProjection.text,
  "the cached document projects exactly like the live nodes it came from"
);

// The selector carries the heatmap-supported quote plus bounded context.
const quoteStart = documentText.indexOf("Altitude");
const selector = hooks.makeDocumentQuoteSelector(
  documentText,
  quoteStart,
  quoteStart + "Altitude lowers".length
);
assert.strictEqual(selector.exact, "Altitude lowers");
assert.deepStrictEqual(plain(selector.contexts), [
  { prefix: "Kettle physics Water boils at 100 C. ", suffix: " it." },
]);
assert.strictEqual(
  hooks.makeDocumentQuoteSelector(documentText, 14, 15),
  null,
  "a span that holds only a separator has no quote to search for"
);

// Context is bounded, so a huge cached document still carries a small selector.
const longDocument = `${"a b ".repeat(200)}TARGET QUOTE${" c d".repeat(200)}`;
const longSelector = hooks.makeDocumentQuoteSelector(
  longDocument,
  longDocument.indexOf("TARGET QUOTE"),
  longDocument.indexOf("TARGET QUOTE") + "TARGET QUOTE".length
);
assert.strictEqual(longSelector.contexts[0].prefix.length, 48);
assert.strictEqual(longSelector.contexts[0].suffix.length, 48);

// An unchanged reloaded page has exactly one candidate, and its cached context
// still fits it.
assert.deepStrictEqual(
  plain(hooks.chooseQuoteMatch(liveProjection.text, selector)),
  {
    index: liveProjection.text.indexOf("Altitude lowers"),
    evidence: "context",
  }
);

// Repeats are separated by the cached context, never by document order.
const repeatedDocument =
  "Intro line.\nThe kettle sings.\nMiddle line.\nThe kettle sings.\nEnd line.";
const secondQuote = repeatedDocument.lastIndexOf("The kettle sings");
const repeatedSelector = hooks.makeDocumentQuoteSelector(
  repeatedDocument,
  secondQuote,
  secondQuote + "The kettle sings".length
);
const repeatedProjection = hooks.buildQuoteProjection(repeatedDocument, [
  { start: 0, end: repeatedDocument.length },
]);
assert.deepStrictEqual(
  plain(hooks.chooseQuoteMatch(repeatedProjection.text, repeatedSelector)),
  {
    index: repeatedProjection.text.lastIndexOf("The kettle sings"),
    evidence: "context",
  }
);

// Indistinguishable repeats and a vanished target both fail closed.
assert.strictEqual(
  hooks.chooseQuoteMatch(
    "The kettle sings. The kettle sings.",
    repeatedSelector
  ),
  null,
  "two candidates with no distinguishing context are rejected"
);
assert.strictEqual(
  hooks.chooseQuoteMatch("Nothing like it here.", selector),
  null
);

// A lone occurrence whose neighbours changed is still unambiguous: it is the
// page's only copy of the attributed text, which is the identity a reloaded
// page has left.
assert.deepStrictEqual(
  plain(
    hooks.chooseQuoteMatch("Rewritten lead. Altitude lowers everything.", selector)
  ),
  { index: 16, evidence: "path" }
);
console.log(
  "PASS: cached-document quotes project, disambiguate, and fail closed"
);

console.log("\nAll round-trip assertions passed.");
