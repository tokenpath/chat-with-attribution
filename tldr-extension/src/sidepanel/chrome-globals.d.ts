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
}

type TldrSummaryLength = "low" | "medium" | "high";

interface TldrAnswerAttributionPhrase {
  start: number;
  end: number;
  confidence: number;
}

interface TldrPanelLogicApi {
  buildAnswerAttributionPhrases(
    heatmap: TldrHeatmap,
    answer: string,
    minimumMass?: number
  ): TldrAnswerAttributionPhrase[];
  buildSummaryRequest(
    text: string,
    length?: TldrSummaryLength
  ): TldrSummaryRequest;
  truncateCodePoints(text: string, maxCodePoints: number): string;
  resolveHeatmapSpan(
    heatmap: TldrHeatmap,
    spanStart: number,
    spanEnd: number,
    document?: string | null,
    answer?: string | null,
    relativeThreshold?: number,
    maxGap?: number
  ): {
    start: number;
    end: number;
    confidence: number;
  } | null;
  codePointToUtf16Map(text: string): number[];
  codePointOffsetToUtf16(map: number[], offset: number): number;
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
