// Pure helpers shared by the side-panel UI and its unit tests.

const TokenPathPanelLogic = (() => {
  const SHORT_SELECTION_WORDS = 24;
  // `maxOutputTokens` is headroom, not a target — the prompt controls length.
  // TokenPath's `/v1/generate` caps `max_output_tokens` at 2048 and bills
  // generation from the input text alone, so a lower ceiling saves nothing and
  // only risks cutting an answer off mid-sentence. Every generation path —
  // summaries and ordinary turns, page, PDF, selection, or video transcript —
  // asks for the whole ceiling.
  const SUMMARY_MAX_OUTPUT_TOKENS = 2_048;
  // "exactly 3", not "2-4": a range makes models drift to the upper bound and
  // makes the 360px panel's height jump between summaries.
  const SUMMARY_PROMPT =
    "Summarize the given text as exactly 3 concise Markdown bullet points. " +
    "Put the single most important takeaway first. Keep each bullet to one " +
    "sentence. Include only what someone needs to understand the source " +
    "quickly.";
  // The second preset. "Detailed" is not "longer": it is a different shape —
  // named sections over the claims, the evidence behind them, the limits the
  // source itself states, and where it lands — so the extra tokens buy
  // structure a reader can scan rather than a padded paragraph.
  const DETAILED_SUMMARY_PROMPT =
    "Write a thorough, structured summary of the given text. Open with one " +
    "short paragraph naming what the source is and its central claim. Then " +
    "use short Markdown section headings with bullet points under each, " +
    "covering: the main claims and what each one asserts; the supporting " +
    "details, evidence, examples, or figures behind them; the " +
    "qualifications, caveats, counterarguments, or limits the source itself " +
    "states; and the conclusions, recommendations, or open questions it ends " +
    "on. Keep every point traceable to something the source actually says, " +
    "prefer its own specific language over generic phrasing, and omit a " +
    "section the source does not address rather than padding it.";
  const SUMMARY_PROMPT_SUFFIX =
    " Finish the summary cleanly. Do not add a title, a 'TL;DR:' label, a " +
    "preamble, an explanation, or a closing comment.";
  // Custom instructions replace the preset, never the suffix or the tail.
  // Bounded so a pasted document cannot become the prompt.
  const MAX_SUMMARY_INSTRUCTIONS_CHARS = 2_000;

  // Follow-up suggestions ride along on the answer's own generation call.
  // Generation is billed from the input text, so asking for them here is
  // free; a second call would re-pay for the whole document.
  const SUGGESTIONS_OPEN = "<<<SUGGESTIONS";
  const SUGGESTIONS_CLOSE = "SUGGESTIONS>>>";
  const SUGGESTION_CANDIDATES = 4;
  const MAX_SUGGESTION_CHIPS = 2;
  const SUGGESTIONS_TAIL =
    "\n\nAfter your answer is complete, and only then, append one block in " +
    "exactly this format:\n" +
    SUGGESTIONS_OPEN +
    "\n" +
    "Q: a question strictly answerable from the provided text, about " +
    "material this answer did not already cover\n" +
    'A: "a verbatim quote of at most 10 words from the provided text that ' +
    'the answer to that question would cite"\n' +
    SUGGESTIONS_CLOSE +
    "\n" +
    `Give exactly ${SUGGESTION_CANDIDATES} Q/A pairs inside that block, ` +
    "alternating Q then A, one per line. Copy every quote character for " +
    "character from the provided text. Write nothing after the closing " +
    SUGGESTIONS_CLOSE +
    " marker, and never mention this block in your answer.";

  function words(text) {
    return String(text || "").trim().match(/\S+/g) || [];
  }

  const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
  const CJK_GLOBAL_RE = new RegExp(CJK_RE.source, "gu");

  // CJK prose has no word spaces, so whitespace tokens measure paragraphs
  // rather than words: a 5,000-character article split into ten paragraphs
  // counts as ten "words" and would look already concise. Judge the script
  // itself instead of trusting the token count.
  function isCjkDominant(text) {
    const dense = text.replace(/\s+/gu, "");
    if (!dense) return false;
    const cjk = dense.match(CJK_GLOBAL_RE);
    return !!cjk && cjk.length * 2 > Array.from(dense).length;
  }

  function measure(text) {
    const clean = String(text || "").trim();
    const wordList = words(clean);
    const codePoints = Array.from(clean);
    const characterMode =
      isCjkDominant(clean) || (wordList.length <= 1 && CJK_RE.test(clean));
    return {
      clean,
      wordList,
      codePoints,
      characterMode,
      units: characterMode ? codePoints.length : wordList.length,
    };
  }

  function boundSummaryInstructions(text) {
    // Defensive on read as well as on write: a hand-edited localStorage value
    // must not become an unbounded prompt.
    return String(text || "").slice(0, MAX_SUMMARY_INSTRUCTIONS_CHARS);
  }

  /** The editable half of the prompt for a preset, with no suffix or tail. */
  function summaryPresetPrompt(preset) {
    return preset === "detailed" ? DETAILED_SUMMARY_PROMPT : SUMMARY_PROMPT;
  }

  /**
   * @param {string} text captured source
   * @param {{preset?: string, customPrompt?: string|null}} [options]
   */
  function buildSummaryRequest(text, options = {}) {
    const source = measure(text);
    const shortLimit = source.characterMode ? 48 : SHORT_SELECTION_WORDS;
    if (source.units <= shortLimit) {
      return { skip: true };
    }

    const custom = boundSummaryInstructions(options.customPrompt).trim();
    const preset = options.preset === "detailed" ? "detailed" : "bullets";
    return {
      skip: false,
      maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS,
      // Custom instructions replace the preset's wording and nothing else:
      // the suffix still lands after them, and so does the suggestions tail.
      prompt: (custom || summaryPresetPrompt(preset)) + SUMMARY_PROMPT_SUFFIX,
      depth: custom ? "custom" : preset,
    };
  }

  /**
   * The tail every generation path appends after its question — summaries and
   * ordinary turns alike. It is never editable and never part of the question
   * sent to attribution.
   */
  function withSuggestionsTail(question) {
    return String(question == null ? "" : question) + SUGGESTIONS_TAIL;
  }

  function suggestionsBlockPattern() {
    // A fresh instance per call: a shared /g regex carries lastIndex.
    return /<<<SUGGESTIONS[\s\S]*?SUGGESTIONS>>>/g;
  }

  const SUGGESTION_QUOTE_PAIRS = [
    ['"', '"'],
    ["“", "”"],
    ["‘", "’"],
    ["'", "'"],
    ["«", "»"],
    ["「", "」"],
    ["„", "“"],
    ["<", ">"],
  ];

  function unwrapSuggestionText(value) {
    let text = String(value || "").trim();
    for (let pass = 0; pass < 3; pass++) {
      const pair = SUGGESTION_QUOTE_PAIRS.find(
        ([open, close]) =>
          text.length >= open.length + close.length + 1 &&
          text.startsWith(open) &&
          text.endsWith(close)
      );
      if (!pair) break;
      text = text.slice(pair[0].length, text.length - pair[1].length).trim();
    }
    return text;
  }

  function parseSuggestionsBlock(block) {
    const body = block.slice(
      SUGGESTIONS_OPEN.length,
      block.length - SUGGESTIONS_CLOSE.length
    );
    const candidates = [];
    let question = null;
    for (const rawLine of body.split(/\r?\n/)) {
      // Tolerate a model that bullets or bolds the lines; reject anything else.
      const line = rawLine
        .trim()
        .replace(/^[-*+]\s+/u, "")
        .replace(/^\*\*([\s\S]*)\*\*$/u, "$1")
        .trim();
      const asked = /^Q\s*[:.：]\s*([\s\S]+)$/u.exec(line);
      if (asked) {
        question = unwrapSuggestionText(asked[1]).slice(0, 240);
        continue;
      }
      const anchored = /^A\s*[:.：]\s*([\s\S]+)$/u.exec(line);
      if (!anchored) continue;
      const anchor = unwrapSuggestionText(anchored[1]);
      if (question && anchor) candidates.push({ question, anchor });
      question = null;
    }
    return candidates;
  }

  /**
   * Remove every suggestions block from an answer — plus a block the stream
   * cut off mid-way, which would otherwise be rendered as a garbled tail.
   * This runs on streaming deltas as well as on the terminal answer, so the
   * marker is never visible and never reaches attribution or the cache.
   */
  function stripSuggestionsBlock(answer) {
    const original = String(answer == null ? "" : answer);
    let value = original.replace(suggestionsBlockPattern(), "");
    // A nested or duplicated block can leave a closing marker behind. It is a
    // deliberately exotic string, so removing a stray one costs nothing and
    // keeps the marker out of the rendered answer.
    value = value.split(SUGGESTIONS_CLOSE).join("");
    const unterminated = value.lastIndexOf(SUGGESTIONS_OPEN);
    if (unterminated !== -1) {
      value = value.slice(0, unterminated);
    } else {
      // A delta may end part-way through the opening marker. Require at least
      // "<<<" so ordinary prose is never truncated.
      for (
        let length = Math.min(SUGGESTIONS_OPEN.length - 1, value.length);
        length >= 3;
        length--
      ) {
        const tail = value.slice(value.length - length);
        if (SUGGESTIONS_OPEN.startsWith(tail)) {
          value = value.slice(0, value.length - length);
          break;
        }
      }
    }
    // An answer that carried no block is returned byte for byte: the terminal
    // `done.answer` is canonical, and trimming it would desynchronize the
    // displayed text from the string sent to attribution.
    return value === original ? original : value.replace(/\s+$/u, "");
  }

  /**
   * Split a generated answer into the text to display, persist, and attribute,
   * and the follow-up candidates its tail block proposed. A malformed or
   * absent block yields no candidates and never garbles the answer.
   */
  function parseSuggestions(answer) {
    const text = String(answer == null ? "" : answer);
    const blocks = text.match(suggestionsBlockPattern()) || [];
    return {
      answer: stripSuggestionsBlock(text),
      // The last block wins: a model that restates the format mid-answer has
      // its final list taken as the real one.
      candidates: blocks.length
        ? parseSuggestionsBlock(blocks[blocks.length - 1])
        : [],
    };
  }

  /**
   * Collapse Unicode whitespace runs to single spaces while remembering where
   * every surviving character came from. The captured document already
   * collapses whitespace per text node but inserts block separators, so an
   * anchor quote spanning a block boundary only matches after both sides are
   * normalized the same way.
   */
  function normalizeWhitespaceWithMap(text) {
    const value = String(text || "");
    let normalized = "";
    const map = [];
    let index = 0;
    while (index < value.length) {
      if (/\s/u.test(value[index])) {
        let end = index;
        while (end < value.length && /\s/u.test(value[end])) end++;
        map.push(index);
        normalized += " ";
        index = end;
        continue;
      }
      map.push(index);
      normalized += value[index];
      index++;
    }
    map.push(value.length);
    return { text: normalized, map };
  }

  function findAnchorRange(anchor, normalizedDocument) {
    const needle = normalizeWhitespaceWithMap(anchor).text.trim();
    if (!needle) return null;
    const at = normalizedDocument.text.indexOf(needle);
    if (at === -1) return null;
    return {
      start: normalizedDocument.map[at],
      end: normalizedDocument.map[at + needle.length],
    };
  }

  /**
   * Gate one: a candidate survives only if its anchor quote appears verbatim
   * in the captured document, case-sensitively, once whitespace is collapsed
   * on both sides. Fail-closed — a fabricated quote drops the whole candidate.
   */
  function groundSuggestions(candidates, document) {
    const normalized = normalizeWhitespaceWithMap(document);
    const grounded = [];
    const seen = new Set();
    for (const candidate of Array.isArray(candidates) ? candidates : []) {
      const question = String(candidate?.question || "").trim();
      const anchor = String(candidate?.anchor || "").trim();
      if (!question || !anchor) continue;
      const key = question.toLowerCase();
      if (seen.has(key)) continue;
      const range = findAnchorRange(anchor, normalized);
      if (!range) continue;
      seen.add(key);
      grounded.push({
        question,
        anchor,
        start: range.start,
        end: range.end,
      });
    }
    return grounded;
  }

  function mergeRegions(regions) {
    const sorted = regions
      .filter(
        ([start, end]) =>
          Number.isFinite(start) && Number.isFinite(end) && end > start
      )
      .sort((first, second) => first[0] - second[0]);
    const merged = [];
    for (const [start, end] of sorted) {
      const last = merged[merged.length - 1];
      if (last && start <= last[1]) {
        last[1] = Math.max(last[1], end);
        continue;
      }
      merged.push([start, end]);
    }
    return merged;
  }

  /**
   * The document regions this answer drew from, derived from the same cached
   * heatmap the underlined phrases and the Sources list use. Each attributed
   * phrase resolves to its supporting passage; the union is what a follow-up
   * should point away from.
   */
  function heatmapCoveredRegions(heatmap, document, answer) {
    if (!heatmap) return [];
    const regions = [];
    for (const phrase of buildAnswerAttributionPhrases(heatmap, answer)) {
      const resolved = resolveHeatmapSpan(
        heatmap,
        phrase.start,
        phrase.end,
        document,
        answer
      );
      if (!resolved) continue;
      regions.push([
        Math.min(resolved.start, resolved.contextStart ?? resolved.start),
        Math.max(resolved.end, resolved.contextEnd ?? resolved.end),
      ]);
    }
    if (regions.length === 0) {
      // No phrase survived segment detection, but the matrix still says which
      // document tokens carried mass.
      const documentOffsets = heatmap.documentOffsets || [];
      const entryCount = Math.min(
        heatmap.row?.length || 0,
        heatmap.col?.length || 0,
        heatmap.data?.length || 0
      );
      for (let index = 0; index < entryCount; index++) {
        const column = heatmap.col[index];
        const mass = heatmap.data[index];
        const offsets = documentOffsets[column];
        if (!Number.isFinite(mass) || mass <= 0 || !offsets) continue;
        regions.push([offsets[0], offsets[1]]);
      }
    }
    return mergeRegions(regions);
  }

  function distanceOutsideRegions(candidate, regions) {
    if (!regions.length) return 0;
    let best = Infinity;
    for (const [start, end] of regions) {
      if (candidate.start < end && start < candidate.end) return 0;
      const gap =
        candidate.start >= end ? candidate.start - end : start - candidate.end;
      if (gap < best) best = gap;
    }
    return Number.isFinite(best) ? best : 0;
  }

  function anchorCenter(candidate) {
    return (candidate.start + candidate.end) / 2;
  }

  /**
   * Gate two: rank grounded candidates by how far their anchors sit outside
   * the regions the answer already drew from, and by how far apart they are
   * from each other. Without a heatmap this degrades to a positional spread
   * biased toward the later part of the document, which the summary of a long
   * page is least likely to have reached.
   *
   * @param {Array} candidates output of groundSuggestions
   * @param {{heatmap?: object|null, document?: string, answer?: string, max?: number}} [options]
   */
  function selectSuggestions(candidates, options = {}) {
    const pool = (Array.isArray(candidates) ? candidates : []).filter(
      (candidate) =>
        candidate &&
        Number.isFinite(candidate.start) &&
        Number.isFinite(candidate.end)
    );
    const max = Number.isInteger(options.max)
      ? options.max
      : MAX_SUGGESTION_CHIPS;
    if (pool.length === 0 || max <= 0) return [];

    const regions = options.heatmap
      ? heatmapCoveredRegions(
          options.heatmap,
          options.document || "",
          options.answer || ""
        )
      : [];
    const base = (candidate) =>
      regions.length
        ? distanceOutsideRegions(candidate, regions)
        : // No coverage information: position alone, which prefers later
          // material over the opening the summary certainly used.
          candidate.start;

    // Landing inside a region the answer already drew on disqualifies a
    // candidate outright — spread never buys a slot back for one. Only when
    // every candidate overlaps does the whole pool come back into play.
    const outside = regions.length
      ? pool.filter((candidate) => distanceOutsideRegions(candidate, regions) > 0)
      : pool;
    const chosen = [];
    const remaining = (outside.length ? outside : pool).slice();
    while (chosen.length < max && remaining.length) {
      let bestIndex = 0;
      let bestScore = -Infinity;
      let bestStart = -Infinity;
      for (let index = 0; index < remaining.length; index++) {
        const candidate = remaining[index];
        const separation = chosen.length
          ? Math.min(
              ...chosen.map((picked) =>
                Math.abs(anchorCenter(candidate) - anchorCenter(picked))
              )
            )
          : 0;
        const score = base(candidate) + separation;
        if (
          score > bestScore ||
          (score === bestScore && candidate.start > bestStart)
        ) {
          bestScore = score;
          bestStart = candidate.start;
          bestIndex = index;
        }
      }
      chosen.push(remaining.splice(bestIndex, 1)[0]);
    }
    return chosen;
  }

  /**
   * The depth ladder's fixed first chip. Slot 1 offers the next depth this
   * chat has not reached; generated candidates fill whatever is left.
   *
   * @returns {"summarize"|"detailed"|null}
   */
  function selectFixedLadderChip({
    hasSummary = false,
    lastSummaryDepth = null,
    defaultPreset = "bullets",
  } = {}) {
    if (!hasSummary) return "summarize";
    // Detailed is the deepest rung, and custom instructions replace the
    // ladder's wording entirely — neither has a deeper step to offer.
    if (lastSummaryDepth === "detailed" || lastSummaryDepth === "custom") {
      return null;
    }
    if (defaultPreset === "detailed" || defaultPreset === "custom") return null;
    return "detailed";
  }

  // TokenPath's limits use Unicode code points; String#slice uses UTF-16 code
  // units. Avoid splitting a surrogate pair at the document limit.
  function truncateCodePoints(text, maxCodePoints) {
    const value = String(text || "");
    if (!Number.isFinite(maxCodePoints) || maxCodePoints < 0) return value;
    let codePoints = 0;
    let codeUnits = 0;
    while (codeUnits < value.length && codePoints < maxCodePoints) {
      const point = value.codePointAt(codeUnits);
      codeUnits += point > 0xffff ? 2 : 1;
      codePoints++;
    }
    return value.slice(0, codeUnits);
  }

  // TokenPath returns Python-style Unicode code-point offsets, but browser
  // strings and DOM Range boundaries use UTF-16 code units. Build this once
  // per API string so every attribution bound can be translated without
  // searching for its text (which would be ambiguous when a phrase repeats).
  function codePointToUtf16Map(text) {
    const map = [0];
    let utf16Offset = 0;
    for (const character of String(text || "")) {
      utf16Offset += character.length;
      map.push(utf16Offset);
    }
    return map;
  }

  function codePointOffsetToUtf16(map, offset) {
    if (!Number.isInteger(offset)) return NaN;
    const index = offset;
    if (index < 0 || index >= map.length) return NaN;
    return map[index];
  }

  function answerTokensOverlapping(answerOffsets, spanStart, spanEnd) {
    const overlapping = new Set();
    for (let index = 0; index < answerOffsets.length; index++) {
      const [tokenStart, tokenEnd] = answerOffsets[index];
      if (tokenEnd > spanStart && tokenStart < spanEnd) {
        overlapping.add(index);
      }
    }
    return overlapping;
  }

  function isAlphaNumeric(character) {
    return /[\p{L}\p{N}]/u.test(character || "");
  }

  function codePointBefore(text, offset) {
    if (offset <= 0) return "";
    let start = offset - 1;
    if (
      /[\uDC00-\uDFFF]/.test(text[start]) &&
      start > 0 &&
      /[\uD800-\uDBFF]/.test(text[start - 1])
    ) {
      start--;
    }
    return text.slice(start, offset);
  }

  function verbatimSnap(
    answerSpanText,
    document,
    attentionStart,
    attentionEnd,
    minLength = 2
  ) {
    const needle = String(answerSpanText || "").trim();
    if (Array.from(needle).length < minLength) return null;

    const center = (attentionStart + attentionEnd) / 2;
    let best = null;
    let bestDistance = Infinity;
    let index = document.indexOf(needle);
    while (index !== -1) {
      const matchStart = index;
      const matchEnd = index + needle.length;
      if (matchEnd > attentionStart && matchStart < attentionEnd) {
        const distance = Math.abs((matchStart + matchEnd) / 2 - center);
        if (distance < bestDistance) {
          bestDistance = distance;
          best = { start: matchStart, end: matchEnd };
        }
      }
      index = document.indexOf(needle, index + 1);
    }
    return best;
  }

  // Browser port of the TokenPath service's span resolver.
  //
  // The heatmap offset tables have already been converted from TokenPath's
  // Unicode code-point coordinates to browser-native UTF-16 coordinates by
  // the API adapter. Keeping the service's aggregation and span-growth rules
  // here means every answer selection can be resolved locally from one cached
  // heatmap without making another attribution request.
  function resolveHeatmapSpan(
    heatmap,
    spanStart,
    spanEnd,
    document = null,
    answer = null,
    relativeThreshold = 0.25,
    maxGap = 3,
    contextMaxGap = 12
  ) {
    if (
      !heatmap ||
      !Number.isInteger(spanStart) ||
      !Number.isInteger(spanEnd) ||
      spanStart < 0 ||
      spanEnd <= spanStart
    ) {
      return null;
    }

    const answerOffsets = heatmap.answerOffsets || [];
    const documentOffsets = heatmap.documentOffsets || [];
    const documentTokenCount = documentOffsets.length;
    const answerTokens = answerTokensOverlapping(
      answerOffsets,
      spanStart,
      spanEnd
    );
    if (answerTokens.size === 0 || documentTokenCount === 0) return null;

    const contributions = [];
    const documentScores = new Map();
    const entryCount = Math.min(
      heatmap.row?.length || 0,
      heatmap.col?.length || 0,
      heatmap.data?.length || 0
    );
    for (let index = 0; index < entryCount; index++) {
      const answerIndex = heatmap.row[index];
      const documentIndex = heatmap.col[index];
      const mass = heatmap.data[index];
      if (
        !Number.isFinite(mass) ||
        mass <= 0 ||
        !answerTokens.has(answerIndex) ||
        !Number.isInteger(documentIndex) ||
        documentIndex < 0 ||
        documentIndex >= documentTokenCount
      ) {
        continue;
      }
      contributions.push([answerIndex, documentIndex, mass]);
      documentScores.set(
        documentIndex,
        (documentScores.get(documentIndex) || 0) + mass
      );
    }
    if (documentScores.size === 0) return null;

    let peak = null;
    let peakScore = -Infinity;
    for (const [token, score] of documentScores) {
      if (score > peakScore) {
        peak = token;
        peakScore = score;
      }
    }
    if (peak == null || !Number.isFinite(peakScore) || peakScore <= 0) {
      return null;
    }

    const threshold = peakScore * relativeThreshold;
    const aboveThreshold = (token) =>
      token >= 0 &&
      token < documentTokenCount &&
      (documentScores.get(token) || 0) >= threshold;
    const grow = (anchor, step, gap = maxGap) => {
      let edge = anchor;
      while (true) {
        let jump = null;
        for (let distance = 1; distance <= gap + 1; distance++) {
          const candidate = edge + step * distance;
          if (aboveThreshold(candidate)) {
            jump = candidate;
            break;
          }
        }
        if (jump == null) return edge;
        edge = jump;
      }
    };

    const startToken = grow(peak, -1);
    const endToken = grow(peak, 1);
    // The same aggregation, grown with a looser gap tolerance, describes the
    // wider passage that supports this selection rather than the exact words
    // to cite. Nothing quotes it — a video seek uses it to start playback at
    // the beginning of the discussion instead of mid-sentence on the phrase.
    const contextStartToken = grow(startToken, -1, contextMaxGap);
    const contextEndToken = grow(endToken, 1, contextMaxGap);
    const perTokenMass = new Map();
    for (const [answerIndex, documentIndex, mass] of contributions) {
      if (documentIndex < startToken || documentIndex > endToken) continue;
      perTokenMass.set(
        answerIndex,
        (perTokenMass.get(answerIndex) || 0) + mass
      );
    }
    let confidence = 0;
    for (const mass of perTokenMass.values()) {
      confidence = Math.max(confidence, mass);
    }

    let charStart = documentOffsets[startToken][0];
    let charEnd = documentOffsets[endToken][1];
    if (typeof document === "string") {
      while (charStart > 0) {
        const character = codePointBefore(document, charStart);
        if (!isAlphaNumeric(character)) break;
        charStart -= character.length;
      }
      while (charEnd < document.length) {
        const character = String.fromCodePoint(
          document.codePointAt(charEnd) || 0
        );
        if (!isAlphaNumeric(character)) break;
        charEnd += character.length;
      }

      if (typeof answer === "string") {
        const verbatim = verbatimSnap(
          answer.slice(spanStart, spanEnd),
          document,
          charStart,
          charEnd
        );
        if (verbatim) {
          charStart = verbatim.start;
          charEnd = verbatim.end;
        }
      }
    }

    return {
      start: charStart,
      end: charEnd,
      confidence: Math.round(confidence * 1_000_000) / 1_000_000,
      // Always a superset of [start, end): the cited span never falls outside
      // the passage it was cited from, even after a verbatim snap moved it.
      contextStart: Math.min(charStart, documentOffsets[contextStartToken][0]),
      contextEnd: Math.max(charEnd, documentOffsets[contextEndToken][1]),
    };
  }

  /**
   * Detect answer spans as line segments in the sparse heatmap.
   *
   * This is a small weighted Hough transform: every above-threshold heatmap
   * cell votes for a set of plausible slopes, nearby votes form finite line
   * segments, and weighted interval scheduling chooses the best non-overlapping
   * answer spans. There is no per-row filtering and no answer-text logic.
   */
  function visibleAnswerTokenBounds(answer, start, end) {
    const tokenText = answer.slice(start, end);
    const withoutLeadingWhitespace = tokenText.trimStart();
    const withoutTrailingWhitespace = tokenText.trimEnd();
    const visibleStart =
      start + tokenText.length - withoutLeadingWhitespace.length;
    const visibleEnd =
      end - (tokenText.length - withoutTrailingWhitespace.length);
    return visibleEnd > visibleStart
      ? { start: visibleStart, end: visibleEnd }
      : null;
  }

  // A model token can begin partway through a word, and its first subtoken can
  // occasionally be the only row without attribution. Repair that display-only
  // edge by restoring the missing Unicode letter/number prefix. Do not cross
  // punctuation or whitespace, since those boundaries may separate phrases.
  function expandAnswerSpanStart(answer, start) {
    if (
      start <= 0 ||
      start >= answer.length ||
      !isAlphaNumeric(String.fromCodePoint(answer.codePointAt(start)))
    ) {
      return start;
    }

    let expanded = start;
    while (expanded > 0) {
      const previous = codePointBefore(answer, expanded);
      if (!isAlphaNumeric(previous)) break;
      expanded -= previous.length;
    }
    return expanded;
  }

  function buildAnswerAttributionPhrases(
    heatmap,
    answer,
    minimumMass = 0.1
  ) {
    if (
      !heatmap ||
      typeof answer !== "string" ||
      !answer
    ) {
      return [];
    }

    const answerOffsets = heatmap.answerOffsets || [];
    const documentTokenCount = (heatmap.documentOffsets || []).length;
    const visibleBounds = answerOffsets.map((offset) =>
      Array.isArray(offset) &&
      Number.isInteger(offset[0]) &&
      Number.isInteger(offset[1]) &&
      offset[0] >= 0 &&
      offset[1] > offset[0] &&
      offset[1] <= answer.length
        ? visibleAnswerTokenBounds(answer, offset[0], offset[1])
        : null
    );
    const points = [];
    const entryCount = Math.min(
      heatmap.row?.length || 0,
      heatmap.col?.length || 0,
      heatmap.data?.length || 0
    );
    for (let entry = 0; entry < entryCount; entry++) {
      const answerIndex = heatmap.row[entry];
      const documentIndex = heatmap.col[entry];
      const mass = heatmap.data[entry];
      const bounds = visibleBounds[answerIndex];
      if (
        !Number.isInteger(answerIndex) ||
        answerIndex < 0 ||
        answerIndex >= answerOffsets.length ||
        !Number.isInteger(documentIndex) ||
        documentIndex < 0 ||
        documentIndex >= documentTokenCount ||
        !Number.isFinite(mass) ||
        mass < minimumMass ||
        !bounds
      ) {
        continue;
      }
      points.push({
        answerIndex,
        column: documentIndex,
        mass,
        start: bounds.start,
        end: bounds.end,
      });
    }
    if (points.length < 2) return [];

    const slopes = Array.from(
      { length: 19 },
      (_, index) => (index - 2) / 4
    );
    const bins = new Map();
    points.forEach((point, pointIndex) => {
      slopes.forEach((slope, slopeIndex) => {
        const interceptBin = Math.round(
          (point.column - slope * point.answerIndex) / 2
        );
        const key = `${slopeIndex}:${interceptBin}`;
        if (!bins.has(key)) bins.set(key, []);
        bins.get(key).push(pointIndex);
      });
    });

    const candidatesByRange = new Map();
    const addSegment = (pointIndices) => {
      const strongestByRow = new Map();
      for (const pointIndex of pointIndices) {
        const point = points[pointIndex];
        const current = strongestByRow.get(point.answerIndex);
        if (!current || point.mass > current.mass) {
          strongestByRow.set(point.answerIndex, point);
        }
      }
      const segment = [...strongestByRow.values()].sort(
        (first, second) => first.answerIndex - second.answerIndex
      );
      if (segment.length < 2) return;

      const start = segment[0].start;
      const end = segment[segment.length - 1].end;
      const mass = segment.reduce((sum, point) => sum + point.mass, 0);
      const candidate = {
        start,
        end,
        confidence: Math.max(...segment.map((point) => point.mass)),
        score: segment.length * segment.length + mass,
      };
      const key = `${start}:${end}`;
      if (
        !candidatesByRange.has(key) ||
        candidatesByRange.get(key).score < candidate.score
      ) {
        candidatesByRange.set(key, candidate);
      }
    };

    for (const pointIndices of bins.values()) {
      const ordered = [...pointIndices].sort(
        (first, second) =>
          points[first].answerIndex - points[second].answerIndex
      );
      let segment = [];
      let lastRow = null;
      for (const pointIndex of ordered) {
        const row = points[pointIndex].answerIndex;
        if (lastRow != null && row - lastRow > 2) {
          addSegment(segment);
          segment = [];
        }
        segment.push(pointIndex);
        lastRow = row;
      }
      addSegment(segment);
    }

    const candidates = [...candidatesByRange.values()].sort(
      (first, second) =>
        first.end - second.end || first.start - second.start
    );
    const best = [{ score: 0, spans: [] }];
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      let previous = index - 1;
      while (
        previous >= 0 &&
        candidates[previous].end > candidate.start
      ) {
        previous--;
      }
      const included = {
        score: best[previous + 1].score + candidate.score,
        spans: [...best[previous + 1].spans, candidate],
      };
      const excluded = best[index];
      best.push(
        included.score > excluded.score ||
        (included.score === excluded.score &&
          included.spans.length < excluded.spans.length)
          ? included
          : excluded
      );
    }

    const selected = best[best.length - 1].spans
      .map(({ start, end, confidence }) => ({
        start,
        end,
        confidence,
      }))
      .sort((first, second) => first.start - second.start);

    return selected.map((span, index) => {
      const expandedStart = expandAnswerSpanStart(answer, span.start);
      const previous = selected[index - 1];
      return {
        ...span,
        start:
          previous && expandedStart < previous.end
            ? span.start
            : expandedStart,
      };
    });
  }

  return {
    MAX_SUGGESTION_CHIPS,
    MAX_SUMMARY_INSTRUCTIONS_CHARS,
    SHORT_SELECTION_WORDS,
    SUGGESTION_CANDIDATES,
    boundSummaryInstructions,
    buildAnswerAttributionPhrases,
    buildSummaryRequest,
    groundSuggestions,
    heatmapCoveredRegions,
    parseSuggestions,
    selectFixedLadderChip,
    selectSuggestions,
    stripSuggestionsBlock,
    summaryPresetPrompt,
    truncateCodePoints,
    codePointToUtf16Map,
    codePointOffsetToUtf16,
    resolveHeatmapSpan,
    withSuggestionsTail,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = TokenPathPanelLogic;
}
