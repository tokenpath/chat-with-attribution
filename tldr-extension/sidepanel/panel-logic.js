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
   * Discover clickable answer spans directly from heatmap topology.
   *
   * Each answer-token row keeps only its strongest document-token candidates.
   * Consecutive rows join when those candidates form a locally continuous,
   * roughly forward-moving path through the document columns. One missing
   * answer-token row may be bridged so a weak punctuation/subword token does
   * not split an otherwise continuous path.
   *
   * This deliberately does not inspect answer text, split words, resolve a
   * source span, or verbatim-snap. Source-span resolution remains a separate
   * operation performed only after the user clicks the discovered answer span.
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

  function buildAnswerAttributionPhrases(
    heatmap,
    answer,
    minimumMass = 0.01
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
    const rows = new Map();
    const entryCount = Math.min(
      heatmap.row?.length || 0,
      heatmap.col?.length || 0,
      heatmap.data?.length || 0
    );
    for (let entry = 0; entry < entryCount; entry++) {
      const answerIndex = heatmap.row[entry];
      const documentIndex = heatmap.col[entry];
      const mass = heatmap.data[entry];
      if (
        !Number.isInteger(answerIndex) ||
        answerIndex < 0 ||
        answerIndex >= answerOffsets.length ||
        !Number.isInteger(documentIndex) ||
        documentIndex < 0 ||
        documentIndex >= documentTokenCount ||
        !Number.isFinite(mass) ||
        mass < minimumMass
      ) {
        continue;
      }
      if (!rows.has(answerIndex)) rows.set(answerIndex, []);
      rows.get(answerIndex).push({ column: documentIndex, mass });
    }

    const profiles = [];
    for (let answerIndex = 0; answerIndex < answerOffsets.length; answerIndex++) {
      const offset = answerOffsets[answerIndex];
      const cells = rows.get(answerIndex);
      if (
        !Array.isArray(offset) ||
        !Number.isInteger(offset[0]) ||
        !Number.isInteger(offset[1]) ||
        offset[0] < 0 ||
        offset[1] <= offset[0] ||
        offset[1] > answer.length ||
        !cells?.length
      ) {
        continue;
      }
      const visibleBounds = visibleAnswerTokenBounds(
        answer,
        offset[0],
        offset[1]
      );
      if (!visibleBounds) continue;

      cells.sort((first, second) => second.mass - first.mass);
      const peak = cells[0].mass;
      const totalMass = cells.reduce((sum, cell) => sum + cell.mass, 0);
      const candidateFloor = peak * 0.5;
      profiles.push({
        answerIndex,
        start: visibleBounds.start,
        end: visibleBounds.end,
        confidence: peak,
        // Diffuse rows are poor boundary evidence even when one noisy cell
        // happens to win. Concentration discounts those rows before anchors
        // are chosen, while keeping the raw peak as the displayed confidence.
        anchorScore: totalMass > 0 ? (peak * peak) / totalMass : 0,
        candidates: cells
          .filter((cell) => cell.mass >= candidateFloor)
          .slice(0, 4),
      });
    }
    if (profiles.length === 0) return [];

    const sortedAnchorScores = profiles
      .map((profile) => profile.anchorScore)
      .sort((first, second) => first - second);
    const medianAnchorScore =
      sortedAnchorScores[Math.floor(sortedAnchorScores.length / 2)] || 0;
    const strongestAnchorScore =
      sortedAnchorScores[sortedAnchorScores.length - 1] || 0;
    const anchorFloor = Math.max(
      0.02,
      medianAnchorScore * 0.75,
      strongestAnchorScore * 0.08
    );
    const anchors = profiles.filter(
      (profile) => profile.anchorScore >= anchorFloor
    );
    if (anchors.length === 0) return [];

    function continuePath(
      previousColumn,
      candidates,
      answerTokenGap,
      direction = 1
    ) {
      let best = null;
      let bestCost = Infinity;
      for (const candidate of candidates) {
        const step = (candidate.column - previousColumn) * direction;
        if (
          step < -2 ||
          step > 4 + 2 * Math.max(1, answerTokenGap)
        ) {
          continue;
        }
        // A true diagonal usually advances by one source token. Staying on the
        // same token is equally plausible for answer subwords and paraphrases.
        const movementCost = Math.min(
          Math.abs(step),
          Math.abs(step - answerTokenGap)
        );
        const cost = movementCost - candidate.mass * 0.01;
        if (cost < bestCost) {
          best = candidate;
          bestCost = cost;
        }
      }
      return best;
    }

    function connection(group, target, direction = 1) {
      const tokenGap =
        direction === 1
          ? target.answerIndex - group.lastAnswerIndex
          : group.firstAnswerIndex - target.answerIndex;
      const characterGap =
        direction === 1
          ? target.start - group.end
          : group.start - target.end;
      if (
        tokenGap < 1 ||
        tokenGap > 8 ||
        characterGap < 0 ||
        characterGap > 4 + 6 * (tokenGap - 1)
      ) {
        return null;
      }
      return continuePath(
        direction === 1 ? group.lastSourceColumn : group.firstSourceColumn,
        target.candidates,
        tokenGap,
        direction
      );
    }

    function startGroup(anchor) {
      const sourceColumn = anchor.candidates[0].column;
      return {
        start: anchor.start,
        end: anchor.end,
        firstAnswerIndex: anchor.answerIndex,
        lastAnswerIndex: anchor.answerIndex,
        firstSourceColumn: sourceColumn,
        lastSourceColumn: sourceColumn,
        confidence: anchor.confidence,
        strongestAnchor: anchor.anchorScore,
        anchorCount: 1,
      };
    }

    function appendAnchor(group, anchor, sourceCandidate) {
      group.end = anchor.end;
      group.lastAnswerIndex = anchor.answerIndex;
      group.lastSourceColumn = sourceCandidate.column;
      group.confidence = Math.max(group.confidence, anchor.confidence);
      group.strongestAnchor = Math.max(
        group.strongestAnchor,
        anchor.anchorScore
      );
      group.anchorCount++;
    }

    // Strong rows define the topology. If one anchor disagrees but the anchor
    // immediately after it reconnects to the current path, treat the middle
    // row as an outlier and absorb it rather than creating two false phrases.
    const groups = [];
    let current = startGroup(anchors[0]);
    for (let index = 1; index < anchors.length; index++) {
      const anchor = anchors[index];
      const direct = connection(current, anchor);
      if (direct) {
        appendAnchor(current, anchor, direct);
        continue;
      }

      const afterOutlier = anchors[index + 1];
      const recovered = afterOutlier
        ? connection(current, afterOutlier)
        : null;
      if (recovered) {
        appendAnchor(current, afterOutlier, recovered);
        index++;
        continue;
      }

      groups.push(current);
      current = startGroup(anchor);
    }
    groups.push(current);

    const profileByIndex = new Map(
      profiles.map((profile) => [profile.answerIndex, profile])
    );
    const singleAnchorFloor = Math.max(0.06, anchorFloor * 1.1);
    const credibleGroups = groups.filter(
      (group) =>
        group.anchorCount > 1 ||
        group.strongestAnchor >= singleAnchorFloor
    );

    // Expand at most two token rows beyond each anchor group when those weaker
    // rows continue the same source path. Low-confidence rows between anchors
    // were already absorbed automatically by the group's [start, end] bounds.
    for (let groupIndex = 0; groupIndex < credibleGroups.length; groupIndex++) {
      const group = credibleGroups[groupIndex];
      const previousGroup = credibleGroups[groupIndex - 1];
      const nextGroup = credibleGroups[groupIndex + 1];

      for (let step = 0; step < 2; step++) {
        const profile = profileByIndex.get(group.firstAnswerIndex - 1);
        if (
          !profile ||
          (previousGroup &&
            profile.answerIndex <= previousGroup.lastAnswerIndex)
        ) {
          break;
        }
        const candidate = connection(group, profile, -1);
        if (!candidate) break;
        group.start = profile.start;
        group.firstAnswerIndex = profile.answerIndex;
        group.firstSourceColumn = candidate.column;
      }

      for (let step = 0; step < 2; step++) {
        const profile = profileByIndex.get(group.lastAnswerIndex + 1);
        if (
          !profile ||
          (nextGroup && profile.answerIndex >= nextGroup.firstAnswerIndex)
        ) {
          break;
        }
        const candidate = connection(group, profile);
        if (!candidate) break;
        group.end = profile.end;
        group.lastAnswerIndex = profile.answerIndex;
        group.lastSourceColumn = candidate.column;
      }
    }

    return credibleGroups.map(({ start, end, confidence }) => ({
      start,
      end,
      confidence,
    }));
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
