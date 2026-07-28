// Pure helpers shared by the side-panel UI and its unit tests.

const TldrPanelLogic = (() => {
  const SHORT_SELECTION_WORDS = 24;
  const SUMMARY_LENGTHS = {
    low: {
      maxOutputTokens: 512,
      prompt:
        "Write a brief summary of the given text. Aim for 2-3 concise " +
        "sentences, or an equivalently compact list or table when structured " +
        "formatting is clearer. Include only the most important points.",
    },
    medium: {
      maxOutputTokens: 768,
      prompt:
        "Write a moderately detailed summary of the given text. Aim for 4-6 " +
        "concise sentences, or an equivalently sized list or table when " +
        "structured formatting is clearer. Cover the main point and important " +
        "supporting details.",
    },
    high: {
      maxOutputTokens: 1024,
      prompt:
        "Write a detailed summary of the given text. Aim for 8-12 concise " +
        "sentences, or an equivalently detailed list or table when structured " +
        "formatting is clearer. Cover the important claims, supporting " +
        "details, qualifications, and conclusions.",
    },
  };
  const SUMMARY_PROMPT_SUFFIX =
    " Finish the summary cleanly. Do not add a title, a 'TL;DR:' label, a " +
    "preamble, an explanation, or a closing comment.";

  function words(text) {
    return String(text || "").trim().match(/\S+/g) || [];
  }

  const CJK_RE = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

  function measure(text) {
    const clean = String(text || "").trim();
    const wordList = words(clean);
    const codePoints = Array.from(clean);
    const characterMode = wordList.length <= 1 && CJK_RE.test(clean);
    return {
      clean,
      wordList,
      codePoints,
      characterMode,
      units: characterMode ? codePoints.length : wordList.length,
    };
  }

  function buildSummaryRequest(text, length = "low") {
    const source = measure(text);
    const shortLimit = source.characterMode ? 48 : SHORT_SELECTION_WORDS;
    if (source.units <= shortLimit) {
      return { skip: true };
    }

    const config =
      length === "medium"
        ? SUMMARY_LENGTHS.medium
        : length === "high"
          ? SUMMARY_LENGTHS.high
          : SUMMARY_LENGTHS.low;
    return {
      skip: false,
      maxOutputTokens: config.maxOutputTokens,
      prompt: config.prompt + SUMMARY_PROMPT_SUFFIX,
    };
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

  // Browser port of tokenpath/service_backend/spans.py::resolve_span.
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
    maxGap = 3
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
    const grow = (anchor, step) => {
      let edge = anchor;
      while (true) {
        let jump = null;
        for (let distance = 1; distance <= maxGap + 1; distance++) {
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
    SHORT_SELECTION_WORDS,
    buildAnswerAttributionPhrases,
    buildSummaryRequest,
    truncateCodePoints,
    codePointToUtf16Map,
    codePointOffsetToUtf16,
    resolveHeatmapSpan,
  };
})();

if (typeof module !== "undefined" && module.exports) {
  module.exports = TldrPanelLogic;
}
