const assert = require("assert");
const Logic = require("../sidepanel/panel-logic.js");

const textWithWords = (count) =>
  Array.from({ length: count }, (_, index) => `w${index}`).join(" ");

for (const count of [1, 10, 24]) {
  const request = Logic.buildSummaryRequest(textWithWords(count));
  assert.strictEqual(request.skip, true, `${count} words should skip auto-summary`);
}
console.log("PASS: already-short selections skip model summarization");

// One prompt, one ceiling. TokenPath caps `max_output_tokens` at 2048 and
// bills generation from the input text alone, so every summary asks for the
// whole ceiling; concision is the prompt's job, not the ceiling's.
const summary = Logic.buildSummaryRequest(textWithWords(25));
assert.strictEqual(summary.skip, false);
assert.strictEqual(summary.maxOutputTokens, 2_048);
assert.match(summary.prompt, /exactly 3 concise Markdown bullet points/);
assert.match(summary.prompt, /most important takeaway first/);
assert.match(summary.prompt, /one sentence/);
assert.match(summary.prompt, /Finish the summary cleanly/);
assert.match(summary.prompt, /Do not add a title/);
// "exactly 3" is deliberate: a range makes models drift to its upper bound and
// makes the panel's height jump between summaries.
assert.doesNotMatch(summary.prompt, /2-4|2-3|4-6|8-12/);

// The request no longer varies by length tier or by source kind — a video
// transcript, a page, and a long CJK article all get the same prompt and the
// same ceiling.
const large = Logic.buildSummaryRequest(textWithWords(500));
assert.deepStrictEqual(large, summary);
const transcript = Logic.buildSummaryRequest(
  `Transcript. ${textWithWords(400)}`
);
assert.strictEqual(transcript.maxOutputTokens, summary.maxOutputTokens);
assert.strictEqual(transcript.prompt, summary.prompt);
// A transcript short enough to be already concise still skips generation.
assert.strictEqual(
  Logic.buildSummaryRequest("A very short transcript.").skip,
  true
);
console.log("PASS: every summary uses one 2048-token ceiling and one prompt");

const cjk = Logic.buildSummaryRequest("这是一个用于验证没有空格的长文本摘要行为并确保模型不会返回比原始选择更长内容的测试段落它还包含更多字符以超过短文本阈值");
assert.strictEqual(cjk.skip, false);
assert.strictEqual(cjk.prompt, summary.prompt);
console.log("PASS: long CJK selections do not bypass summarization");

// A CJK article has no word spaces, so its paragraph breaks are the only
// whitespace: counting tokens would call a 5,000-character page ten "words".
const cjkParagraph = "这是一个用于验证中文文章摘要行为的段落".repeat(26);
const cjkArticle = Array.from({ length: 10 }, () => cjkParagraph).join("\n");
assert.ok(cjkArticle.length > 4_000);
assert.ok(cjkArticle.trim().match(/\S+/g).length <= Logic.SHORT_SELECTION_WORDS);
const cjkArticleSummary = Logic.buildSummaryRequest(cjkArticle);
assert.strictEqual(cjkArticleSummary.skip, false);
assert.strictEqual(cjkArticleSummary.maxOutputTokens, 2_048);

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

// ---------------------------------------------------------------------------
// Summary presets, custom instructions, and the suggestions tail
// ---------------------------------------------------------------------------

const detailed = Logic.buildSummaryRequest(textWithWords(300), {
  preset: "detailed",
});
assert.strictEqual(detailed.skip, false);
assert.strictEqual(detailed.depth, "detailed");
// Same ceiling as every other generation path: output is free.
assert.strictEqual(detailed.maxOutputTokens, 2_048);
assert.match(detailed.prompt, /thorough, structured summary/);
assert.match(detailed.prompt, /main claims/);
assert.match(detailed.prompt, /supporting\s+details, evidence/);
assert.match(detailed.prompt, /qualifications, caveats/);
assert.match(detailed.prompt, /conclusions, recommendations/);
// The suffix is shared with the 3-bullet preset, never replaced by it.
assert.ok(
  detailed.prompt.endsWith(
    " Finish the summary cleanly. Do not add a title, a 'TL;DR:' label, a " +
      "preamble, an explanation, or a closing comment."
  )
);
assert.doesNotMatch(detailed.prompt, /exactly 3 concise Markdown bullet/);
// An unknown preset falls back to the 3-bullet default rather than guessing.
assert.strictEqual(
  Logic.buildSummaryRequest(textWithWords(300), { preset: "wat" }).prompt,
  Logic.buildSummaryRequest(textWithWords(300)).prompt
);
// A short source still skips generation whatever the preset says.
assert.strictEqual(
  Logic.buildSummaryRequest("Three words only", { preset: "detailed" }).skip,
  true
);
console.log("PASS: the Detailed preset is a distinct prompt at the same ceiling");

const customInstructions =
  "List every dollar figure in the text with the sentence it came from.";
const custom = Logic.buildSummaryRequest(textWithWords(300), {
  preset: "detailed",
  customPrompt: customInstructions,
});
// Custom instructions replace the preset's wording — and only that.
assert.strictEqual(custom.depth, "custom");
assert.ok(custom.prompt.startsWith(customInstructions));
assert.doesNotMatch(custom.prompt, /thorough, structured summary/);
assert.doesNotMatch(custom.prompt, /exactly 3 concise Markdown bullet/);
assert.match(custom.prompt, /Finish the summary cleanly/);
// Whitespace-only custom instructions are not a customization.
assert.strictEqual(
  Logic.buildSummaryRequest(textWithWords(300), { customPrompt: "   \n " })
    .depth,
  "bullets"
);
// The stored value is bounded on read, not merely on write.
const overlong = "x".repeat(Logic.MAX_SUMMARY_INSTRUCTIONS_CHARS + 500);
assert.strictEqual(
  Logic.boundSummaryInstructions(overlong).length,
  Logic.MAX_SUMMARY_INSTRUCTIONS_CHARS
);
const boundedCustom = Logic.buildSummaryRequest(textWithWords(300), {
  customPrompt: overlong,
});
assert.strictEqual(
  boundedCustom.prompt.length,
  Logic.MAX_SUMMARY_INSTRUCTIONS_CHARS +
    " Finish the summary cleanly. Do not add a title, a 'TL;DR:' label, a preamble, an explanation, or a closing comment."
      .length
);
assert.ok(
  Logic.summaryPresetPrompt("detailed").includes("thorough, structured summary")
);
assert.strictEqual(
  Logic.summaryPresetPrompt("bullets"),
  Logic.summaryPresetPrompt("anything else")
);
console.log("PASS: custom instructions replace the preset, never the suffix");

// The tail is appended after the question or prompt+suffix, for every path.
for (const question of [
  custom.prompt,
  detailed.prompt,
  "What did the author conclude?",
]) {
  const tailed = Logic.withSuggestionsTail(question);
  assert.ok(tailed.startsWith(question));
  assert.match(tailed, /<<<SUGGESTIONS/);
  assert.match(tailed, /SUGGESTIONS>>>/);
  assert.match(tailed, /exactly 4 Q\/A pairs/);
  assert.match(tailed, /verbatim quote of at most 10 words/);
}
assert.strictEqual(Logic.SUGGESTION_CANDIDATES, 4);
assert.strictEqual(Logic.MAX_SUGGESTION_CHIPS, 2);
console.log("PASS: every generation path can append the same suggestions tail");

// ---------------------------------------------------------------------------
// Suggestions tail parsing
// ---------------------------------------------------------------------------

const wellFormed = Logic.parseSuggestions(
  "- The report says revenue grew.\n" +
    "- It also names three risks.\n\n" +
    "<<<SUGGESTIONS\n" +
    "Q: What were the three named risks?\n" +
    'A: "supply concentration, currency exposure, and hiring"\n' +
    "Q: How large was the dividend?\n" +
    'A: "a dividend of $1.24 per share"\n' +
    "SUGGESTIONS>>>\n"
);
assert.strictEqual(
  wellFormed.answer,
  "- The report says revenue grew.\n- It also names three risks."
);
assert.ok(!wellFormed.answer.includes("SUGGESTIONS"));
assert.deepStrictEqual(wellFormed.candidates, [
  {
    question: "What were the three named risks?",
    anchor: "supply concentration, currency exposure, and hiring",
  },
  {
    question: "How large was the dividend?",
    anchor: "a dividend of $1.24 per share",
  },
]);

// No block at all: the answer is untouched and nothing is suggested.
const plain = Logic.parseSuggestions("A perfectly ordinary answer.");
assert.strictEqual(plain.answer, "A perfectly ordinary answer.");
assert.deepStrictEqual(plain.candidates, []);

// A block the stream never closed is a garbled tail, not content.
const truncated = Logic.parseSuggestions(
  'The answer body.\n\n<<<SUGGESTIONS\nQ: What else?\nA: "the quote'
);
assert.strictEqual(truncated.answer, "The answer body.");
assert.deepStrictEqual(truncated.candidates, []);

// The same is true of a delta that stopped part-way through the marker.
assert.strictEqual(
  Logic.stripSuggestionsBlock("Body text.\n\n<<<SUGG"),
  "Body text."
);
assert.strictEqual(Logic.stripSuggestionsBlock("Body text.\n\n<<<"), "Body text.");
// Ordinary prose that merely contains angle brackets is never truncated.
assert.strictEqual(Logic.stripSuggestionsBlock("a < b"), "a < b");
assert.strictEqual(
  Logic.stripSuggestionsBlock("Use <div> and <<"),
  "Use <div> and <<"
);

// Malformed pairs are dropped individually; the block still parses.
const malformed = Logic.parseSuggestions(
  "Body.\n<<<SUGGESTIONS\n" +
    "Q: A question with no anchor\n" +
    "Q: A question that does have one\n" +
    'A: "the anchor"\n' +
    'A: "an anchor with no question"\n' +
    "not a pair at all\n" +
    "SUGGESTIONS>>>"
);
assert.strictEqual(malformed.answer, "Body.");
assert.deepStrictEqual(malformed.candidates, [
  { question: "A question that does have one", anchor: "the anchor" },
]);

// Several blocks: the last one is authoritative and every one is stripped.
const multiple = Logic.parseSuggestions(
  'First part.\n<<<SUGGESTIONS\nQ: Early question?\nA: "early anchor"\nSUGGESTIONS>>>\n' +
    'Second part.\n<<<SUGGESTIONS\nQ: Late question?\nA: "late anchor"\nSUGGESTIONS>>>'
);
assert.strictEqual(multiple.answer, "First part.\n\nSecond part.");
assert.ok(!multiple.answer.includes("SUGGESTIONS"));
assert.deepStrictEqual(multiple.candidates, [
  { question: "Late question?", anchor: "late anchor" },
]);

// A nested opener inside a block is inert text, and nothing leaks out.
const nested = Logic.parseSuggestions(
  'Body.\n<<<SUGGESTIONS\n<<<SUGGESTIONS\nQ: Nested question?\nA: "nested anchor"\nSUGGESTIONS>>>\nSUGGESTIONS>>>'
);
assert.ok(!nested.answer.includes("SUGGESTIONS"));
assert.strictEqual(nested.answer, "Body.");
assert.deepStrictEqual(nested.candidates, [
  { question: "Nested question?", anchor: "nested anchor" },
]);

// CJK, emoji, curly quotes, and bulleted lines all round-trip.
const unicode = Logic.parseSuggestions(
  "答案正文。\n<<<SUGGESTIONS\n" +
    "- Q: 作者提到了哪三个风险？\n" +
    "- A: “供应链集中、汇率波动与招聘”\n" +
    "**Q: Which emoji did the post use? 🎓**\n" +
    "A: 'the graduation cap 🎓 in the headline'\n" +
    "SUGGESTIONS>>>"
);
assert.strictEqual(unicode.answer, "答案正文。");
assert.deepStrictEqual(unicode.candidates, [
  { question: "作者提到了哪三个风险？", anchor: "供应链集中、汇率波动与招聘" },
  {
    question: "Which emoji did the post use? 🎓",
    anchor: "the graduation cap 🎓 in the headline",
  },
]);

// A model that echoes the template's angle-bracket placeholders is unwrapped.
assert.deepStrictEqual(
  Logic.parseSuggestions(
    'Body.\n<<<SUGGESTIONS\nQ: <What is the deadline?>\nA: <"before 5pm on Friday">\nSUGGESTIONS>>>'
  ).candidates,
  [{ question: "What is the deadline?", anchor: "before 5pm on Friday" }]
);
console.log("PASS: the suggestions tail is parsed and never rendered");

// ---------------------------------------------------------------------------
// Gate one: the anchor quote must exist verbatim in the captured document
// ---------------------------------------------------------------------------

const groundDocument =
  "The board approved the plan.\nRevenue grew\n   by  eleven percent\n" +
  "across the quarter. 供应链集中 remained the largest risk 🎓 overall.";
const grounded = Logic.groundSuggestions(
  [
    { question: "How much did revenue grow?", anchor: "grew by eleven percent" },
    { question: "Fabricated?", anchor: "revenue fell by nine percent" },
    { question: "Wrong case?", anchor: "The Board Approved" },
    { question: "CJK anchor?", anchor: "供应链集中" },
    { question: "Emoji anchor?", anchor: "largest risk 🎓" },
    { question: "", anchor: "the board approved" },
    { question: "No anchor?", anchor: "" },
  ],
  groundDocument
);
assert.deepStrictEqual(
  grounded.map((candidate) => candidate.question),
  ["How much did revenue grow?", "CJK anchor?", "Emoji anchor?"]
);
// The whitespace-collapsed match still reports offsets into the real document.
const growth = grounded[0];
assert.strictEqual(
  groundDocument.slice(growth.start, growth.end),
  "grew\n   by  eleven percent"
);
const emojiAnchor = grounded[2];
assert.strictEqual(
  groundDocument.slice(emojiAnchor.start, emojiAnchor.end),
  "largest risk 🎓"
);
// A quote that only differs by line breaks and runs of spaces still matches.
assert.strictEqual(
  Logic.groundSuggestions(
    [{ question: "Across?", anchor: "percent   across\n\nthe quarter" }],
    groundDocument
  ).length,
  1
);
// Duplicate questions collapse to one candidate.
assert.strictEqual(
  Logic.groundSuggestions(
    [
      { question: "Same?", anchor: "the plan" },
      { question: "same?", anchor: "Revenue grew" },
    ],
    groundDocument
  ).length,
  1
);
console.log("PASS: a fabricated anchor quote drops its whole candidate");

// ---------------------------------------------------------------------------
// Gate two: coverage ranking against a synthetic heatmap
// ---------------------------------------------------------------------------

const coverageDocument =
  "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi";
const coverageOffsets = [];
for (let cursor = 0; cursor < coverageDocument.length; ) {
  const next = coverageDocument.indexOf(" ", cursor);
  const end = next === -1 ? coverageDocument.length : next;
  coverageOffsets.push([cursor, end]);
  cursor = end + 1;
}
const coverageAnswer = "one two";
// Both answer tokens draw on the opening of the document ("alpha".."gamma").
const coverageHeatmap = {
  row: [0, 0, 1, 1],
  col: [0, 1, 1, 2],
  data: [0.9, 0.8, 0.85, 0.7],
  shape: [2, coverageOffsets.length],
  answerOffsets: [
    [0, 3],
    [4, 7],
  ],
  documentOffsets: coverageOffsets,
};
const covered = Logic.heatmapCoveredRegions(
  coverageHeatmap,
  coverageDocument,
  coverageAnswer
);
assert.ok(covered.length >= 1);
assert.strictEqual(covered[0][0], 0);
assert.ok(covered[0][1] <= coverageDocument.indexOf("delta"));

const at = (word) => ({
  start: coverageDocument.indexOf(word),
  end: coverageDocument.indexOf(word) + word.length,
});
const coverageCandidates = [
  { question: "Covered opening?", ...at("beta") },
  { question: "Just outside?", ...at("epsilon") },
  { question: "Far end?", ...at("xi") },
  { question: "Middle?", ...at("iota") },
];
const ranked = Logic.selectSuggestions(coverageCandidates, {
  heatmap: coverageHeatmap,
  document: coverageDocument,
  answer: coverageAnswer,
});
assert.strictEqual(ranked.length, 2);
// The anchor inside the region the answer already used never wins a slot.
assert.ok(!ranked.some((candidate) => candidate.question === "Covered opening?"));
// Farthest from the covered region first.
assert.strictEqual(ranked[0].question, "Far end?");
// The second slot goes to an anchor that is both outside the covered region
// and well away from the first pick.
assert.ok(
  Math.abs(ranked[1].start - ranked[0].start) >
    coverageDocument.indexOf("iota") - coverageDocument.indexOf("epsilon")
);
// Never more than two chips, and never more than there are candidates.
assert.strictEqual(
  Logic.selectSuggestions(coverageCandidates.slice(0, 1), {
    heatmap: coverageHeatmap,
    document: coverageDocument,
    answer: coverageAnswer,
  }).length,
  1
);
assert.deepStrictEqual(Logic.selectSuggestions([], {}), []);

// Without a heatmap the fallback spreads positionally, biased later.
const spread = Logic.selectSuggestions(coverageCandidates, {});
assert.strictEqual(spread.length, 2);
assert.strictEqual(spread[0].question, "Far end?");
assert.ok(spread[1].start < spread[0].start);
console.log("PASS: coverage ranking prefers material the answer did not use");

// ---------------------------------------------------------------------------
// The depth ladder's fixed first chip
// ---------------------------------------------------------------------------

assert.strictEqual(
  Logic.selectFixedLadderChip({ hasSummary: false }),
  "summarize"
);
assert.strictEqual(
  Logic.selectFixedLadderChip({
    hasSummary: false,
    defaultPreset: "detailed",
  }),
  "summarize"
);
assert.strictEqual(
  Logic.selectFixedLadderChip({
    hasSummary: true,
    lastSummaryDepth: "bullets",
    defaultPreset: "bullets",
  }),
  "detailed"
);
assert.strictEqual(
  Logic.selectFixedLadderChip({
    hasSummary: true,
    lastSummaryDepth: "detailed",
    defaultPreset: "bullets",
  }),
  null
);
assert.strictEqual(
  Logic.selectFixedLadderChip({
    hasSummary: true,
    lastSummaryDepth: "bullets",
    defaultPreset: "detailed",
  }),
  null
);
assert.strictEqual(
  Logic.selectFixedLadderChip({
    hasSummary: true,
    lastSummaryDepth: "custom",
    defaultPreset: "custom",
  }),
  null
);
assert.strictEqual(Logic.selectFixedLadderChip(), "summarize");
console.log("PASS: the depth ladder offers only the rung this chat has not used");

console.log("\nAll panel-logic assertions passed.");
