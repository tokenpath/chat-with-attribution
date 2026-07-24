interface TldrAttribution {
  answerStart: number;
  answerEnd: number;
  sourceStart: number;
  sourceEnd: number;
  confidence?: number;
}

interface TldrSummaryRequest {
  skip: boolean;
  sourceWords: number;
  sourceUnits: number;
  maxWords?: number | null;
  maxUnits?: number;
  maxOutputTokens?: number;
  prompt?: string;
}

interface TldrPanelLogicApi {
  buildSummaryRequest(text: string): TldrSummaryRequest;
  enforceShorterSummary(
    answer: string,
    source: string,
    requestedMaxUnits?: number | null
  ): string;
  truncateCodePoints(text: string, maxCodePoints: number): string;
  annotateMarkdownAttributions(
    answer: string,
    attributions: TldrAttribution[]
  ): string;
}

interface TokenPathFailure extends Error {
  status: number;
  code: string;
}

interface TokenPathApi {
  Error: {
    new (status: number, code: string, message: string): TokenPathFailure;
    prototype: TokenPathFailure;
  };
  PLATFORM_URL: string;
  MAX_DOCUMENT_CHARS: number;
  getAuth(): Promise<{ key: string | null; baseUrl: string }>;
  setKey(key: string): Promise<void>;
  clearKey(): Promise<void>;
  fetchCredits(): Promise<number>;
  answer(input: {
    document: string;
    question: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
    maxOutputTokens?: number | null;
  }): Promise<{
    answer: string;
    attributions: TldrAttribution[];
    creditsRemaining: number | null;
  }>;
}

declare const TldrPanelLogic: TldrPanelLogicApi;
declare const TokenPath: TokenPathApi;
declare function formatTokens(value: number | null): string;

declare module "*.css";
