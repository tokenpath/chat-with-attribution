const assert = require("assert");
const Logic = require("../sidepanel/panel-logic.js");

const textWithWords = (count) =>
  Array.from({ length: count }, (_, index) => `w${index}`).join(" ");

for (const count of [1, 10, 24]) {
  const request = Logic.buildSummaryRequest(textWithWords(count));
  assert.strictEqual(request.skip, true, `${count} words should skip auto-summary`);
}
console.log("PASS: already-short selections skip model summarization");

const defaultSummary = Logic.buildSummaryRequest(textWithWords(25));
const lowSummary = Logic.buildSummaryRequest(textWithWords(25), "low");
const mediumSummary = Logic.buildSummaryRequest(textWithWords(25), "medium");
const highSummary = Logic.buildSummaryRequest(textWithWords(25), "high");
assert.deepStrictEqual(defaultSummary, lowSummary);
assert.strictEqual(lowSummary.skip, false);
assert.strictEqual(lowSummary.maxOutputTokens, 512);
assert.strictEqual(mediumSummary.maxOutputTokens, 768);
assert.strictEqual(highSummary.maxOutputTokens, 1024);
assert.match(lowSummary.prompt, /Aim for 2-3 concise sentences/);
assert.match(mediumSummary.prompt, /Aim for 4-6 concise sentences/);
assert.match(highSummary.prompt, /Aim for 8-12 concise sentences/);
for (const request of [lowSummary, mediumSummary, highSummary]) {
  assert.match(request.prompt, /Finish the summary cleanly/);
  assert.match(request.prompt, /Do not add a title/);
}

const large = Logic.buildSummaryRequest(textWithWords(500));
assert.strictEqual(large.prompt, lowSummary.prompt);
console.log("PASS: low/medium/high summary prompts and headroom stay distinct");

const cjk = Logic.buildSummaryRequest("这是一个用于验证没有空格的长文本摘要行为并确保模型不会返回比原始选择更长内容的测试段落它还包含更多字符以超过短文本阈值");
assert.strictEqual(cjk.skip, false);
assert.strictEqual(cjk.prompt, lowSummary.prompt);
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

const phraseAnswer = "The LLaDA2.2-flash model was a breakthrough.";
const answerToken = (text, from = 0) => {
  const start = phraseAnswer.indexOf(text, from);
  return [start, start + text.length];
};
const phraseHeatmap = {
  // Row 3 (".2") has no surviving mass. The topology may bridge that one
  // weak answer token, but rows 6-7 ("was a") remain below the 0.01 floor.
  row: [0, 1, 2, 4, 5, 6, 7, 8],
  col: [0, 10, 11, 13, 14, 15, 16, 30],
  data: [0.009, 0.91, 0.88, 0.86, 0.82, 0.009, 0.008, 0.93],
  shape: [10, 40],
  documentOffsets: Array.from({ length: 40 }, (_, index) => [
    index * 2,
    index * 2 + 1,
  ]),
  answerOffsets: [
    answerToken("The"),
    answerToken("LLaDA"),
    answerToken("2", phraseAnswer.indexOf("LLaDA") + 5),
    answerToken(".2"),
    answerToken("-flash"),
    answerToken("model"),
    answerToken("was"),
    answerToken("a", phraseAnswer.indexOf("was") + 3),
    answerToken("breakthrough"),
    answerToken("."),
  ],
};
const clickablePhrases = Logic.buildAnswerAttributionPhrases(
  phraseHeatmap,
  phraseAnswer
);
assert.deepStrictEqual(
  clickablePhrases.map(({ start, end }) => phraseAnswer.slice(start, end)),
  ["LLaDA2.2-flash model", "breakthrough"]
);
assert.ok(
  clickablePhrases.every(
    (phrase) => Number.isFinite(phrase.confidence)
  )
);
assert.ok(
  !clickablePhrases.some(({ start, end }) =>
    phraseAnswer.slice(start, end).includes("was a")
  )
);
console.log("PASS: answer-token diagonals preserve identifiers and ignore weak rows");

const jumpAnswer = "alpha beta gamma";
const jumpPhrases = Logic.buildAnswerAttributionPhrases(
  {
    row: [0, 1, 2],
    col: [2, 3, 20],
    data: [0.8, 0.75, 0.9],
    shape: [3, 24],
    documentOffsets: Array.from({ length: 24 }, (_, index) => [
      index,
      index + 1,
    ]),
    // Model token offsets commonly own the whitespace before their text.
    answerOffsets: [[0, 5], [5, 10], [10, 16]],
  },
  jumpAnswer
);
assert.deepStrictEqual(
  jumpPhrases.map(({ start, end }) => jumpAnswer.slice(start, end)),
  ["alpha beta", "gamma"]
);
assert.strictEqual(
  jumpAnswer.slice(jumpPhrases[0].end, jumpPhrases[1].start),
  " "
);
assert.ok(
  jumpPhrases.every(
    ({ start, end }) =>
      !/^\s|\s$/u.test(jumpAnswer.slice(start, end))
  )
);
console.log("PASS: discontinuous paths retain visible gaps between phrases");

const decimalAnswer = "703.82 TPS on function calling and";
const decimalPieces = ["703", ".", "82", " TPS", " on", " function", " calling", " and"];
let decimalOffset = 0;
const decimalOffsets = decimalPieces.map((piece) => {
  const start = decimalOffset;
  decimalOffset += piece.length;
  return [start, decimalOffset];
});
const decimalPhrases = Logic.buildAnswerAttributionPhrases(
  {
    // The decimal point is deliberately a strong but wrong anchor at column
    // 50. The anchors immediately around it continue 10 -> 11, so it must be
    // treated as an outlier and absorbed into one coherent answer span.
    row: [0, 1, 2, 3, 4, 5, 6, 7],
    col: [10, 50, 11, 12, 13, 14, 15, 16],
    data: [0.9, 0.8, 0.85, 0.7, 0.05, 0.75, 0.72, 0.04],
    shape: [8, 64],
    documentOffsets: Array.from({ length: 64 }, (_, index) => [
      index,
      index + 1,
    ]),
    answerOffsets: decimalOffsets,
  },
  decimalAnswer
);
assert.deepStrictEqual(
  decimalPhrases.map(({ start, end }) => decimalAnswer.slice(start, end)),
  [decimalAnswer]
);
console.log("PASS: anchor recovery absorbs a spurious decimal-point attribution");

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
