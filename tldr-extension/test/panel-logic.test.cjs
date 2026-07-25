const assert = require("assert");
const Logic = require("../sidepanel/panel-logic.js");

const textWithWords = (count) =>
  Array.from({ length: count }, (_, index) => `w${index}`).join(" ");

for (const count of [1, 10, 24]) {
  const request = Logic.buildSummaryRequest(textWithWords(count));
  assert.strictEqual(request.skip, true, `${count} words should skip auto-summary`);
}
console.log("PASS: already-short selections skip model summarization");

const medium = Logic.buildSummaryRequest(textWithWords(25));
assert.strictEqual(medium.skip, false);
assert.strictEqual(medium.maxWords, 12);
assert.ok(medium.maxWords < medium.sourceWords);
assert.ok(medium.maxOutputTokens >= 16 && medium.maxOutputTokens <= 128);
assert.match(medium.prompt, /at most 12 words/);

const large = Logic.buildSummaryRequest(textWithWords(500));
assert.strictEqual(large.maxWords, 80);
assert.strictEqual(large.maxOutputTokens, 128);
console.log("PASS: summary word and token budgets scale and cap");

assert.strictEqual(
  Logic.enforceShorterSummary("one two three four", "one two three"),
  "one two…"
);
assert.strictEqual(
  Logic.enforceShorterSummary("short answer", "this source has several more words"),
  "short answer"
);
assert.ok(
  Logic.enforceShorterSummary(textWithWords(30), textWithWords(25), 12)
    .match(/\S+/g).length < 25
);
console.log("PASS: displayed TL;DR is always strictly shorter than its source");

const cjk = Logic.buildSummaryRequest("这是一个用于验证没有空格的长文本摘要行为并确保模型不会返回比原始选择更长内容的测试段落它还包含更多字符以超过短文本阈值");
assert.strictEqual(cjk.skip, false);
assert.match(cjk.prompt, /characters/);
console.log("PASS: long CJK selections do not bypass summarization");

assert.strictEqual(Logic.truncateCodePoints("ab🙂cd", 3), "ab🙂");
assert.strictEqual(Logic.truncateCodePoints("ab🙂cd", 4), "ab🙂c");
console.log("PASS: document limits never split emoji surrogate pairs");

const linkedInText =
  'From “You Are Not Good Enough” to “We Are Proud of You” 🎓\n' +
  "This degree carries the weight of every failure, rejection, and criticism.";
const criticismStart = linkedInText.indexOf("criticism");
const criticismEnd = criticismStart + "criticism".length;
const criticismCodePointStart = Array.from(
  linkedInText.slice(0, criticismStart)
).length;
const criticismCodePointEnd = criticismCodePointStart + "criticism".length;
const linkedInOffsetMap = Logic.codePointToUtf16Map(linkedInText);
assert.strictEqual(criticismStart, criticismCodePointStart + 1);
assert.strictEqual(
  Logic.codePointOffsetToUtf16(linkedInOffsetMap, criticismCodePointStart),
  criticismStart
);
assert.strictEqual(
  Logic.codePointOffsetToUtf16(linkedInOffsetMap, criticismCodePointEnd),
  criticismEnd
);
assert.strictEqual(linkedInText.slice(criticismStart, criticismEnd), "criticism");

assert.deepStrictEqual(Logic.codePointToUtf16Map("abc"), [0, 1, 2, 3]);
const multiEmoji = "A🎓B🚀";
const multiEmojiMap = Logic.codePointToUtf16Map(multiEmoji);
assert.deepStrictEqual(multiEmojiMap, [0, 1, 3, 4, 6]);
assert.strictEqual(
  multiEmoji.slice(
    Logic.codePointOffsetToUtf16(multiEmojiMap, 1),
    Logic.codePointOffsetToUtf16(multiEmojiMap, 4)
  ),
  "🎓B🚀"
);
assert.ok(Number.isNaN(Logic.codePointOffsetToUtf16(multiEmojiMap, -1)));
assert.ok(Number.isNaN(Logic.codePointOffsetToUtf16(multiEmojiMap, 5)));
assert.ok(Number.isNaN(Logic.codePointOffsetToUtf16(multiEmojiMap, 1.5)));
console.log("PASS: TokenPath code-point offsets convert to exact browser UTF-16 bounds");

const heatmap = {
  row: [1, 2, 2],
  col: [1, 2, 3],
  data: [0.9, 0.2, 0.15],
  shape: [3, 4],
  documentOffsets: [[0, 5], [6, 10], [11, 16], [17, 22]],
  answerOffsets: [[0, 3], [4, 8], [9, 14]],
};
const heatmapDocument = "alpha beta gamma delta";
const betaSpan = Logic.resolveHeatmapSpan(
  heatmap,
  4,
  8,
  heatmapDocument,
  "the beta value"
);
assert.deepStrictEqual(betaSpan, { start: 6, end: 10, confidence: 0.9 });
const valueSpan = Logic.resolveHeatmapSpan(
  heatmap,
  9,
  14,
  heatmapDocument,
  "the beta value"
);
assert.strictEqual(
  heatmapDocument.slice(valueSpan.start, valueSpan.end),
  "gamma delta"
);
assert.strictEqual(valueSpan.confidence, 0.35);
assert.strictEqual(
  Logic.resolveHeatmapSpan(heatmap, 0, 3, heatmapDocument, "the beta value"),
  null
);
console.log("PASS: arbitrary answer spans aggregate cached heatmap rows");

const bridged = Logic.resolveHeatmapSpan(
  {
    row: [0, 0, 0, 0],
    col: [0, 1, 2, 3],
    data: [0.9, 0.05, 0.05, 0.6],
    shape: [1, 4],
    documentOffsets: [[0, 5], [6, 10], [11, 16], [17, 22]],
    answerOffsets: [[0, 4]],
  },
  0,
  4,
  heatmapDocument,
  "fact"
);
assert.strictEqual(
  heatmapDocument.slice(bridged.start, bridged.end),
  heatmapDocument
);

const weakNeighbor = Logic.resolveHeatmapSpan(
  {
    row: [0, 0],
    col: [1, 2],
    data: [0.9, 0.02],
    shape: [1, 4],
    documentOffsets: [[0, 5], [6, 10], [11, 16], [17, 22]],
    answerOffsets: [[0, 4]],
  },
  0,
  4,
  heatmapDocument,
  "fact"
);
assert.strictEqual(
  heatmapDocument.slice(weakNeighbor.start, weakNeighbor.end),
  "beta"
);

const beyondGap = Logic.resolveHeatmapSpan(
  {
    row: [0, 0],
    col: [0, 3],
    data: [0.9, 0.6],
    shape: [1, 4],
    documentOffsets: [[0, 5], [6, 10], [11, 16], [17, 22]],
    answerOffsets: [[0, 4]],
  },
  0,
  4,
  heatmapDocument,
  "fact",
  0.25,
  1
);
assert.strictEqual(
  heatmapDocument.slice(beyondGap.start, beyondGap.end),
  "alpha"
);

const bestTokenConfidence = Logic.resolveHeatmapSpan(
  {
    row: [0, 1],
    col: [0, 0],
    data: [0.8, 0.05],
    shape: [2, 1],
    documentOffsets: [[0, 3]],
    answerOffsets: [[0, 2], [2, 3]],
  },
  0,
  3
);
assert.strictEqual(bestTokenConfidence.confidence, 0.8);

const paraphrase = Logic.resolveHeatmapSpan(
  {
    row: [0],
    col: [1],
    data: [0.9],
    shape: [1, 4],
    documentOffsets: [[0, 5], [6, 10], [11, 16], [17, 22]],
    answerOffsets: [[0, 7]],
  },
  0,
  7,
  heatmapDocument,
  "revenue"
);
assert.strictEqual(
  heatmapDocument.slice(paraphrase.start, paraphrase.end),
  "beta"
);
assert.strictEqual(
  Logic.resolveHeatmapSpan(
    {
      row: [0],
      col: [99],
      data: [0.9],
      shape: [1, 4],
      documentOffsets: [[0, 5], [6, 10], [11, 16], [17, 22]],
      answerOffsets: [[0, 4]],
    },
    0,
    4
  ),
  null
);
console.log("PASS: resolver golden vectors stay in sync with TokenPath");

const repeatedDocument = "Fable 5 appeared first. Later Fable 5 shipped worldwide.";
const secondFable = repeatedDocument.lastIndexOf("Fable 5");
const repeated = Logic.resolveHeatmapSpan(
  {
    row: [0],
    col: [0],
    data: [0.94],
    shape: [1, 1],
    documentOffsets: [[secondFable + 1, secondFable + 6]],
    answerOffsets: [[0, 7]],
  },
  0,
  7,
  repeatedDocument,
  "Fable 5"
);
assert.deepStrictEqual(
  { start: repeated.start, end: repeated.end },
  { start: secondFable, end: secondFable + 7 }
);
console.log("PASS: source span growth and attention-local duplicate snapping match TokenPath");

const emojiDocument = "A 🎓 launch happened.";
const emojiHeatmap = {
  row: [0],
  col: [0],
  data: [0.8],
  shape: [1, 1],
  documentOffsets: [[2, 4]],
  answerOffsets: [[0, 2]],
};
assert.deepStrictEqual(
  Logic.resolveHeatmapSpan(
    emojiHeatmap,
    0,
    2,
    emojiDocument,
    "🎓"
  ),
  { start: 2, end: 4, confidence: 0.8 }
);
console.log("PASS: heatmap resolution uses browser UTF-16 offsets around emoji");

console.log("\nAll panel-logic assertions passed.");
