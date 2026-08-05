interface TldrHeatmap {
  row: number[];
  col: number[];
  data: number[];
  shape: [number, number];
  documentOffsets: Array<[number, number]>;
  answerOffsets: Array<[number, number]>;
}

interface TldrSummaryRequest {
  skip: boolean;
  maxOutputTokens?: number;
  prompt?: string;
  /** Which rung of the depth ladder this request represents. */
  depth?: "bullets" | "detailed" | "custom";
}

/** One Q/A pair lifted from an answer's suggestions tail block. */
interface TldrSuggestionCandidate {
  question: string;
  anchor: string;
}

/** A candidate whose anchor quote was found verbatim in the document. */
interface TldrGroundedSuggestion extends TldrSuggestionCandidate {
  start: number;
  end: number;
}

interface TldrAnswerAttributionPhrase {
  start: number;
  end: number;
  confidence: number;
}

interface TldrPanelLogicApi {
  MAX_SUGGESTION_CHIPS: number;
  MAX_SUMMARY_INSTRUCTIONS_CHARS: number;
  SUGGESTION_CANDIDATES: number;
  boundSummaryInstructions(text: string): string;
  buildAnswerAttributionPhrases(
    heatmap: TldrHeatmap,
    answer: string,
    minimumMass?: number
  ): TldrAnswerAttributionPhrase[];
  buildSummaryRequest(
    text: string,
    options?: {
      preset?: string;
      customPrompt?: string | null;
    }
  ): TldrSummaryRequest;
  groundSuggestions(
    candidates: TldrSuggestionCandidate[],
    document: string
  ): TldrGroundedSuggestion[];
  heatmapCoveredRegions(
    heatmap: TldrHeatmap | null,
    document: string,
    answer: string
  ): Array<[number, number]>;
  parseSuggestions(answer: string): {
    answer: string;
    candidates: TldrSuggestionCandidate[];
  };
  selectFixedLadderChip(state?: {
    hasSummary?: boolean;
    lastSummaryDepth?: string | null;
    defaultPreset?: string;
  }): "summarize" | "detailed" | null;
  selectSuggestions(
    candidates: TldrGroundedSuggestion[],
    options?: {
      heatmap?: TldrHeatmap | null;
      document?: string;
      answer?: string;
      max?: number;
    }
  ): TldrGroundedSuggestion[];
  stripSuggestionsBlock(answer: string): string;
  summaryPresetPrompt(preset: string): string;
  withSuggestionsTail(question: string): string;
  truncateCodePoints(text: string, maxCodePoints: number): string;
  resolveHeatmapSpan(
    heatmap: TldrHeatmap,
    spanStart: number,
    spanEnd: number,
    document?: string | null,
    answer?: string | null,
    relativeThreshold?: number,
    maxGap?: number,
    contextMaxGap?: number
  ): {
    start: number;
    end: number;
    confidence: number;
    /** The wider supported passage; always contains [start, end). */
    contextStart: number;
    contextEnd: number;
  } | null;
  codePointToUtf16Map(text: string): number[];
  codePointOffsetToUtf16(map: number[], offset: number): number;
}

/**
 * "canceling" is still a paid month: the allowance is spendable until
 * `renewsAt`, which is when it ends rather than renews.
 */
type TokenPathSubscriptionStatus = "none" | "active" | "canceling";

interface TokenPathSubscription {
  status: TokenPathSubscriptionStatus;
  /** ISO 8601, or null when there is nothing to renew or end. */
  renewsAt: string | null;
  /** What is left of this month's allowance. */
  allowanceTokens: number;
  /** What a full month grants. */
  grantTokens: number;
  priceUsdCents: number;
}

interface TokenPathFailure extends Error {
  status: number;
  code: string;
  details: Record<string, unknown> | null;
}

interface TokenPathApi {
  Error: {
    new (
      status: number,
      code: string,
      message: string,
      details?: Record<string, unknown> | null
    ): TokenPathFailure;
    prototype: TokenPathFailure;
  };
  PLATFORM_URL: string;
  MAX_DOCUMENT_CHARS: number;
  getAuth(): Promise<{ key: string | null; baseUrl: string }>;
  setKey(key: string): Promise<void>;
  clearKey(): Promise<void>;
  fetchCredits(): Promise<number>;
  /** A 404 resolves to a "none" plan rather than rejecting. */
  fetchSubscription(): Promise<TokenPathSubscription>;
  generate(input: {
    messages: Array<{
      role: "system" | "user" | "assistant";
      content: string;
    }>;
    maxOutputTokens?: number | null;
    onDelta?: (delta: string, accumulated: string) => void;
    signal?: AbortSignal;
  }): Promise<{
    answer: string;
    model: string;
    usage: {
      input_tokens: number;
      output_tokens: number;
      billed_tokens: number;
    };
    creditsRemaining: number | null;
  }>;
  heatmap(input: {
    document: string;
    question: string;
    answer: string;
    threshold?: number;
    signal?: AbortSignal;
  }): Promise<TldrHeatmap>;
}

declare const TldrPanelLogic: TldrPanelLogicApi;
declare const TokenPath: TokenPathApi;
declare function formatTokens(value: number | null): string;

declare module "*.css";
