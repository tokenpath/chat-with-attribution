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
assert.strictEqual(lowSummary.prompt, Logic.defaultSummaryPrompt("low"));
assert.strictEqual(lowSummary.skip, false);
assert.strictEqual(lowSummary.maxOutputTokens, 512);
assert.strictEqual(mediumSummary.maxOutputTokens, 768);
assert.strictEqual(highSummary.maxOutputTokens, 1024);
assert.match(lowSummary.prompt, /2-4 concise Markdown bullet points/);
assert.match(lowSummary.prompt, /most important takeaway first/);
assert.match(mediumSummary.prompt, /Aim for 4-6 concise sentences/);
assert.match(highSummary.prompt, /Aim for 8-12 concise sentences/);
for (const request of [lowSummary, mediumSummary, highSummary]) {
  assert.match(request.prompt, /Finish the summary cleanly/);
  assert.match(request.prompt, /Do not add a title/);
}
const customPrompt = Logic.buildSummaryRequest(
  textWithWords(25),
  "low",
  "page",
  "  Explain this for a product manager in exactly three bullets.  "
);
assert.strictEqual(
  customPrompt.prompt,
  "Explain this for a product manager in exactly three bullets."
);
assert.strictEqual(customPrompt.maxOutputTokens, 512);
console.log("PASS: a custom summary prompt replaces the default instructions");

const large = Logic.buildSummaryRequest(textWithWords(500));
assert.strictEqual(large.prompt, lowSummary.prompt);
console.log("PASS: low/medium/high summary prompts and headroom stay distinct");

// A video transcript gets a higher headroom tier at every length: even a
// "brief" summary of an hour of speech overruns a page-sized ceiling and stops
// mid-sentence. The prompts are identical — only the ceiling moves — and the
// tiers stay ordered, so Short remains genuinely shorter than Detailed.
const videoLow = Logic.buildSummaryRequest(textWithWords(25), "low", "video");
const videoMedium = Logic.buildSummaryRequest(
  textWithWords(25),
  "medium",
  "video"
);
const videoHigh = Logic.buildSummaryRequest(textWithWords(25), "high", "video");
assert.strictEqual(videoLow.maxOutputTokens, 1_024);
assert.strictEqual(videoMedium.maxOutputTokens, 1_536);
assert.strictEqual(videoHigh.maxOutputTokens, 2_048);
assert.ok(videoLow.maxOutputTokens < videoMedium.maxOutputTokens);
assert.ok(videoMedium.maxOutputTokens < videoHigh.maxOutputTokens);
assert.strictEqual(videoLow.prompt, lowSummary.prompt);
assert.strictEqual(videoHigh.prompt, highSummary.prompt);
// Every video tier clears the page tier it corresponds to.
assert.ok(videoLow.maxOutputTokens > lowSummary.maxOutputTokens);
assert.ok(videoMedium.maxOutputTokens > mediumSummary.maxOutputTokens);
assert.ok(videoHigh.maxOutputTokens > highSummary.maxOutputTokens);
// An unknown or absent source kind is a page.
assert.strictEqual(
  Logic.buildSummaryRequest(textWithWords(25), "low", "page").maxOutputTokens,
  512
);
assert.strictEqual(
  Logic.buildSummaryRequest(textWithWords(25), "low", undefined)
    .maxOutputTokens,
  512
);
// A transcript short enough to be already concise still skips generation.
assert.strictEqual(
  Logic.buildSummaryRequest("A very short transcript.", "low", "video").skip,
  true
);
console.log("PASS: video transcripts get a higher, still-ordered headroom tier");

const cjk = Logic.buildSummaryRequest("这是一个用于验证没有空格的长文本摘要行为并确保模型不会返回比原始选择更长内容的测试段落它还包含更多字符以超过短文本阈值");
assert.strictEqual(cjk.skip, false);
assert.strictEqual(cjk.prompt, lowSummary.prompt);
console.log("PASS: long CJK selections do not bypass summarization");

// A CJK article has no word spaces, so its paragraph breaks are the only
// whitespace: counting tokens would call a 5,000-character page ten "words".
const cjkParagraph = "这是一个用于验证中文文章摘要行为的段落".repeat(26);
const cjkArticle = Array.from({ length: 10 }, () => cjkParagraph).join("\n");
assert.ok(cjkArticle.length > 4_000);
assert.ok(cjkArticle.trim().match(/\S+/g).length <= Logic.SHORT_SELECTION_WORDS);
const cjkArticleSummary = Logic.buildSummaryRequest(cjkArticle, "medium");
assert.strictEqual(cjkArticleSummary.skip, false);
assert.strictEqual(cjkArticleSummary.maxOutputTokens, 768);

// Japanese and Korean use the same character-aware path.
for (const long of [
  "これは日本語の長い記事です。".repeat(12) + "\n" + "段落が変わります。".repeat(12),
  "이것은 한국어로 된 긴 기사입니다.".repeat(8) + "\n" + "문단이 바뀝니다.".repeat(8),
]) {
  assert.strictEqual(Logic.buildSummaryRequest(long).skip, false, long.slice(0, 8));
}

// Genuinely short CJK stays "already concise", including across paragraphs.
assert.strictEqual(Logic.buildSummaryRequest("这是一个很短的段落。\n第二段也很短。").skip, true);
assert.strictEqual(Logic.buildSummaryRequest("短い。\nとても短い。").skip, true);

// Mixed text that is mostly Latin keeps the word-count cutoff.
const latinWithCjk = `${textWithWords(20)} 漢字 ${textWithWords(3)}`;
assert.strictEqual(Logic.buildSummaryRequest(latinWithCjk).skip, true);
assert.strictEqual(
  Logic.buildSummaryRequest(`${textWithWords(60)} 漢字`).skip,
  false
);
console.log("PASS: multi-paragraph CJK articles use the character-aware cutoff");

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
assert.deepStrictEqual(betaSpan, {
  start: 6,
  end: 10,
  confidence: 0.9,
  contextStart: 6,
  contextEnd: 10,
});
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
  // weak answer token, but rows 6-7 ("was a") remain below the 0.1 floor.
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
  ["LLaDA2.2-flash model"]
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
  ["alpha beta"]
);
assert.ok(
  jumpPhrases.every(
    ({ start, end }) =>
      !/^\s|\s$/u.test(jumpAnswer.slice(start, end))
  )
);
console.log("PASS: a Hough segment ignores an isolated source jump");

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
  ["703.82 TPS on function calling"]
);
console.log("PASS: a Hough segment spans over spurious decimal-point attribution");

const nestedAnswer = "an AI Deployment Engineer";
const nestedPieces = ["an", " AI", " Deployment", " Engineer"];
let nestedOffset = 0;
const nestedOffsets = nestedPieces.map((piece) => {
  const start = nestedOffset;
  nestedOffset += piece.length;
  return [start, nestedOffset];
});
const nestedPhrases = Logic.buildAnswerAttributionPhrases(
  {
    // The main diagonal covers the full title. "Engineer" also has a second,
    // separate source attribution; its nested one-row component must not split
    // the answer-side phrase.
    row: [0, 1, 2, 3, 3],
    col: [10, 11, 12, 13, 30],
    data: [0.3, 0.82, 0.78, 0.76, 0.7],
    shape: [4, 40],
    documentOffsets: Array.from({ length: 40 }, (_, index) => [
      index,
      index + 1,
    ]),
    answerOffsets: nestedOffsets,
  },
  nestedAnswer
);
assert.deepStrictEqual(
  nestedPhrases.map(({ start, end }) => nestedAnswer.slice(start, end)),
  [nestedAnswer]
);
console.log("PASS: global interval selection keeps the full-title line");

const absoluteThresholdAnswer = "low signal";
const absoluteThresholdPhrases = Logic.buildAnswerAttributionPhrases(
  {
    // The 0.2 cell in row 0 is far below that row's 0.9 peak, but it belongs
    // to the real 30 -> 31 line and must not be removed by row-relative logic.
    row: [0, 0, 1],
    col: [5, 30, 31],
    data: [0.9, 0.2, 0.2],
    shape: [2, 40],
    documentOffsets: Array.from({ length: 40 }, (_, index) => [
      index,
      index + 1,
    ]),
    answerOffsets: [[0, 3], [3, 10]],
  },
  absoluteThresholdAnswer
);
assert.deepStrictEqual(
  absoluteThresholdPhrases.map(({ start, end }) =>
    absoluteThresholdAnswer.slice(start, end)
  ),
  [absoluteThresholdAnswer]
);
console.log("PASS: Hough voting uses every cell above the absolute threshold");

const bentAnswer = "aa bb cc dd ee";
const bentPhrases = Logic.buildAnswerAttributionPhrases(
  {
    // Two lines touch at answer row 2 but have incompatible slopes. A local
    // connected-component walk would merge all five rows; global interval
    // selection must choose a line rather than manufacture one bent span.
    row: [0, 1, 2, 3, 4],
    col: [0, 1, 2, 6, 10],
    data: [0.8, 0.8, 0.8, 0.8, 0.8],
    shape: [5, 12],
    documentOffsets: Array.from({ length: 12 }, (_, index) => [
      index,
      index + 1,
    ]),
    answerOffsets: [[0, 2], [2, 5], [5, 8], [8, 11], [11, 14]],
  },
  bentAnswer
);
assert.ok(
  bentPhrases.length === 2 &&
    !bentPhrases.some(
      ({ start, end }) => start === 0 && end === bentAnswer.length
    )
);
console.log("PASS: touching lines do not merge into one bent answer span");

const missingPrefixAnswer = "The Deployment Engineer";
const missingPrefixPhrases = Logic.buildAnswerAttributionPhrases(
  {
    // The first subtoken ("De") has no surviving attribution. The detected
    // line starts at "ployment", so the display span should restore only the
    // missing beginning of that same word.
    row: [1, 2],
    col: [10, 11],
    data: [0.8, 0.78],
    shape: [3, 16],
    documentOffsets: Array.from({ length: 16 }, (_, index) => [
      index,
      index + 1,
    ]),
    answerOffsets: [[4, 6], [6, 14], [14, 23]],
  },
  missingPrefixAnswer
);
assert.deepStrictEqual(
  missingPrefixPhrases.map(({ start, end }) =>
    missingPrefixAnswer.slice(start, end)
  ),
  ["Deployment Engineer"]
);
console.log("PASS: a missing first subtoken restores its same-word prefix");

const punctuationBoundaryAnswer = "prefix.result value";
const punctuationBoundaryPhrases = Logic.buildAnswerAttributionPhrases(
  {
    row: [0, 1],
    col: [10, 11],
    data: [0.8, 0.78],
    shape: [2, 16],
    documentOffsets: Array.from({ length: 16 }, (_, index) => [
      index,
      index + 1,
    ]),
    answerOffsets: [[7, 13], [13, 19]],
  },
  punctuationBoundaryAnswer
);
assert.deepStrictEqual(
  punctuationBoundaryPhrases.map(({ start, end }) =>
    punctuationBoundaryAnswer.slice(start, end)
  ),
  ["result value"]
);
console.log("PASS: prefix repair never crosses punctuation");

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
  { start: 2, end: 4, confidence: 0.8, contextStart: 2, contextEnd: 4 }
);
console.log("PASS: heatmap resolution uses browser UTF-16 offsets around emoji");

// The supported neighbourhood: the same aggregation and threshold, grown with
// a looser gap tolerance. It describes the passage a claim was drawn from —
// nothing quotes it, so a wider bound cannot mis-cite; a video seek uses it to
// start playback where the discussion begins.
const passageDocument =
  "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu";
const passageOffsets = [];
for (let cursor = 0; cursor < passageDocument.length; ) {
  const next = passageDocument.indexOf(" ", cursor);
  const end = next === -1 ? passageDocument.length : next;
  passageOffsets.push([cursor, end]);
  cursor = end + 1;
}
// Peak on "theta" (token 7) with real but weaker support running back to
// "gamma" (token 2) across a two-token dip the exact span refuses to bridge.
const passageHeatmap = {
  row: [0, 0, 0, 0, 0],
  col: [2, 3, 6, 7, 8],
  data: [0.4, 0.35, 0.5, 0.9, 0.4],
  shape: [1, passageOffsets.length],
  documentOffsets: passageOffsets,
  answerOffsets: [[0, 5]],
};
const passage = Logic.resolveHeatmapSpan(
  passageHeatmap,
  0,
  5,
  passageDocument,
  "claim",
  0.25,
  1
);
// The cited span stops at the gap the tight tolerance will not cross.
assert.strictEqual(
  passageDocument.slice(passage.start, passage.end),
  "eta theta iota"
);
// The neighbourhood reaches back over it to where the support actually starts.
assert.strictEqual(
  passageDocument.slice(passage.contextStart, passage.contextEnd),
  "gamma delta epsilon zeta eta theta iota"
);
// It is always a superset of the cited span.
assert.ok(passage.contextStart <= passage.start);
assert.ok(passage.contextEnd >= passage.end);
// Unsupported tokens beyond the looser tolerance are still excluded.
assert.ok(!passageDocument.slice(passage.contextStart).startsWith("alpha"));
assert.ok(
  !passageDocument
    .slice(passage.contextStart, passage.contextEnd)
    .includes("kappa")
);
// A tighter context tolerance collapses the neighbourhood onto the span.
const noExpansion = Logic.resolveHeatmapSpan(
  passageHeatmap,
  0,
  5,
  passageDocument,
  "claim",
  0.25,
  1,
  0
);
assert.strictEqual(noExpansion.contextStart, noExpansion.start);
assert.strictEqual(noExpansion.contextEnd, noExpansion.end);
console.log("PASS: the supported neighbourhood widens without moving the citation");

console.log("\nAll panel-logic assertions passed.");
