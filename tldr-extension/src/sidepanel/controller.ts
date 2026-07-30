import { extractPdfText } from "@/pdf-text-extractor";
import {
  clearAll,
  deletePageChat,
  pageChatKey,
  pageContentSignificantlyChanged,
  readPageChat,
  sameDocumentUrl,
  writePageChat,
} from "@/chat-cache";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export type SummaryLength = "low" | "medium" | "high";
export type CaptureIntent = "tldr" | "simplify" | "ask";
export type SourceType = "page" | "chrome-pdf";
// "video-transcript" is a full-document capture whose document is the video's
// subtitle transcript rather than the page's rendered text. Its highlight
// route is still the content script — the frame owns the transcript-offset to
// timestamp cue table and answers an attributed span by seeking the player —
// so it stays a "page" SourceType.
export type CaptureMode =
  | "selection"
  | "full-page"
  | "full-pdf"
  | "video-transcript";
export type ContextSourceType = "selection" | "page" | "pdf" | "video";
export type ContextStatus = "idle" | "reading" | "ready" | "error";

export interface SelectionSeed {
  type?: string;
  captureId?: string | null;
  capturedAt?: number;
  seededAt?: number;
  tabId?: number | null;
  windowId?: number | null;
  frameId?: number;
  captureMode?: CaptureMode;
  intent?: CaptureIntent;
  sourceType?: SourceType;
  url?: string | null;
  text?: string;
  error?: string;
  truncated?: boolean;
  transcriptUnavailable?: boolean;
}

export interface HighlightSource {
  tabId: number | null;
  frameId: number;
  captureId: string | null;
  contextVersion: number;
  sourceType: SourceType;
  url: string | null;
}

interface ActiveHighlight {
  id: string;
  source: HighlightSource;
}

export type AnswerStatus =
  | "streaming"
  | "attributing"
  | "ready"
  | "unavailable";

export interface MessageAttribution {
  document: string;
  question: string;
  status: "loading" | "ready" | "error";
  heatmap?: TldrHeatmap;
  error?: string;
}

export interface PanelMessage {
  id: string;
  role: "user" | "assistant";
  kind: "text" | "answer" | "note" | "error";
  text: string;
  answerStatus?: AnswerStatus;
  attribution?: MessageAttribution;
  incomplete?: boolean;
  source?: HighlightSource;
  link?: {
    label: string;
    href: string;
  };
}

export interface PanelSnapshot {
  authBusy: boolean;
  authError: string | null;
  busy: boolean;
  connected: boolean;
  contextError: string | null;
  contextLabel: string;
  contextStatus: ContextStatus;
  contextText: string;
  creditsText: string | null;
  hasContext: boolean;
  messages: PanelMessage[];
  notice: string | null;
  resolvedTheme: ResolvedTheme;
  sourceType: ContextSourceType;
  summaryLength: SummaryLength;
  summaryPrompt: string;
  summaryPromptCustomized: boolean;
  themePreference: ThemePreference;
  toast: string | null;
  toastSeq: number;
}

// Every message of one context shares the same captured document, and that
// document can be 400,000 characters. The cached record stores each distinct
// document once and has its messages reference it by index.
interface CachedMessageAttribution {
  documentIndex: number;
  question: string;
  status: MessageAttribution["status"];
  heatmap?: TldrHeatmap;
  error?: string;
}

type CachedPanelMessage = Omit<PanelMessage, "attribution"> & {
  attribution?: CachedMessageAttribution;
};

interface CachedPageChat {
  version: 2;
  context: string;
  contextLabel: string;
  captureMode: CaptureMode;
  sourceType: SourceType;
  documents: string[];
  history: Array<{ role: "user" | "assistant"; content: string }>;
  messages: CachedPanelMessage[];
}

const CACHE_FORMAT_VERSION = 2;
const THEME_KEY = "tldr-theme";
const SUMMARY_LENGTH_KEY = "tldr-summary-length";
const SUMMARY_PROMPT_KEY = "tldr-summary-prompt";
export const SUMMARY_PROMPT_MAX_CHARS = 2000;
const MAX_GENERATE_INPUT_CHARS = 420_000;
const MAX_GENERATE_MESSAGES = 50;
const CHAT_OUTPUT_TOKENS = 512;
// An answer about an hour of speech cites and qualifies more than an answer
// about a page, and a cut-off answer is worse than a long one.
const VIDEO_CHAT_OUTPUT_TOKENS = 1_024;
// Tokenizer counts can disagree with the sampler's stop by one, so treat "one
// short of the ceiling" as having reached it.
const OUTPUT_LIMIT_TOLERANCE_TOKENS = 1;
const SUMMARY_LENGTH_LABELS: Record<SummaryLength, string> = {
  low: "Short",
  medium: "Medium",
  high: "Detailed",
};
// A capture the panel never consumed outlives the click that produced it. Two
// minutes covers a slow side-panel open without replaying yesterday's page.
const MAX_SEED_AGE_MS = 120_000;

function websiteBaseUrl(pageUrl?: string | null) {
  if (!pageUrl || pageUrl.length > 16_384) return "the current webpage";
  try {
    const parsed = new URL(pageUrl);
    const origin = new URL(parsed.origin);
    return origin.protocol === "http:" || origin.protocol === "https:"
      ? origin.origin
      : "the current webpage";
  } catch {
    return "the current webpage";
  }
}

function readThemePreference(): ThemePreference {
  try {
    const stored = localStorage.getItem(THEME_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") {
      return stored;
    }
  } catch {
    // The panel can still follow the OS theme if storage is unavailable.
  }
  return "system";
}

function readSummaryLength(): SummaryLength {
  try {
    const stored = localStorage.getItem(SUMMARY_LENGTH_KEY);
    if (stored === "low" || stored === "medium" || stored === "high") {
      return stored;
    }
  } catch {
    // The default remains available if local storage is unavailable.
  }
  return "low";
}

function readSummaryPrompt(summaryLength: SummaryLength) {
  try {
    const stored = localStorage.getItem(SUMMARY_PROMPT_KEY)?.trim();
    if (stored) {
      return {
        prompt: stored.slice(0, SUMMARY_PROMPT_MAX_CHARS),
        customized: true,
      };
    }
  } catch {
    // The default remains available if local storage is unavailable.
  }
  return {
    prompt: TldrPanelLogic.defaultSummaryPrompt(summaryLength),
    customized: false,
  };
}

function systemTheme(): ResolvedTheme {
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function resolveTheme(preference: ThemePreference): ResolvedTheme {
  return preference === "system" ? systemTheme() : preference;
}

export class PanelController {
  private listeners = new Set<() => void>();
  private snapshot: PanelSnapshot;
  private earlyCaptures: SelectionSeed[] = [];
  private tabId: number | null = null;
  private windowId: number | null = null;
  private frameId = 0;
  private captureId: string | null = null;
  private capturedAt = 0;
  private sourceBaseUrl = "the current webpage";
  private sourceType: SourceType = "page";
  private captureMode: CaptureMode = "selection";
  private autoSummaryRequested = false;
  private sourceUrl: string | null = null;
  private context = "";
  private history: Array<{
    role: "user" | "assistant";
    content: string;
  }> = [];
  private invalidated = false;
  private contextVersion = 0;
  private authEpoch = 0;
  private creditsEpoch = 0;
  private highlightEpoch = 0;
  private highlightedTarget: ActiveHighlight | null = null;
  private pendingPdfHighlight: ActiveHighlight | null = null;
  private pendingSubmission: string | null = null;
  private messageSequence = 0;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private mediaQuery: MediaQueryList | null = null;
  private activeTurnController: AbortController | null = null;
  private activeTurnCleanup: (() => void) | null = null;
  private activeTurnMessageId: string | null = null;
  private activePdfExtractionController: AbortController | null = null;
  private heatmapControllers = new Map<string, AbortController>();
  private navigationEpoch = 0;

  constructor() {
    const themePreference = readThemePreference();
    const resolvedTheme = resolveTheme(themePreference);
    const summaryLength = readSummaryLength();
    const summaryPrompt = readSummaryPrompt(summaryLength);
    this.snapshot = {
      authBusy: false,
      authError: null,
      busy: false,
      connected: false,
      contextError: null,
      contextLabel: "Current page",
      contextStatus: "idle",
      contextText: "",
      creditsText: null,
      hasContext: false,
      messages: [],
      notice: null,
      resolvedTheme,
      sourceType: "page",
      summaryLength,
      summaryPrompt: summaryPrompt.prompt,
      summaryPromptCustomized: summaryPrompt.customized,
      themePreference,
      toast: null,
      toastSeq: 0,
    };
    this.applyTheme(resolvedTheme);
    this.watchSystemTheme();

    // This must happen synchronously, before init() performs even its first
    // await. A newly opened side panel can otherwise miss a fast capture.
    chrome.runtime.onMessage.addListener(this.handleRuntimeMessage);
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = () => this.snapshot;

  async init() {
    this.watchTab();
    const authReady = this.initAuth();
    const [tab] = await chrome.tabs.query({
      active: true,
      currentWindow: true,
    });
    this.tabId = tab?.id ?? null;
    this.windowId = tab?.windowId ?? null;
    this.sourceBaseUrl = websiteBaseUrl(tab?.url);

    const earlyCapture = this.earlyCaptures
      .filter(
        (message) =>
          this.windowId == null ||
          message.windowId == null ||
          message.windowId === this.windowId
      )
      .sort(
        (left, right) =>
          (Number(right.capturedAt) || 0) -
          (Number(left.capturedAt) || 0)
      )[0];
    this.earlyCaptures = [];
    let seeded = earlyCapture ? this.applySeed(earlyCapture) : false;
    if (this.tabId != null && !seeded) {
      const key = this.seedKey(this.tabId);
      const stored = await chrome.storage.session.get(key);
      const seed = stored[key] as SelectionSeed | undefined;
      if (seed) {
        // The seed is keyed only by tab, so it can describe a document the tab
        // has since left. Only a URL that is known on both sides can prove a
        // mismatch; the age bound covers the rest, measured from the
        // background's write time (seededAt) so a slow extraction is not
        // penalized for the gap between click and write.
        const liveUrl = tab?.url || null;
        const seedTime = Number(seed.seededAt ?? seed.capturedAt);
        const stale =
          (Boolean(liveUrl) &&
            Boolean(seed.url) &&
            !sameDocumentUrl(seed.url, liveUrl)) ||
          (Number.isFinite(seedTime) &&
            Date.now() - seedTime > MAX_SEED_AGE_MS);
        if (!stale) seeded = this.applySeed(seed);
        void chrome.storage.session.remove?.(key);
      }
    }

    if (!seeded && this.tabId != null) {
      this.sourceUrl = tab?.url || null;
      this.sourceBaseUrl = websiteBaseUrl(this.sourceUrl);
      const restored = await this.restorePageChat(
        null,
        this.contextVersion,
        false
      );
      if (!restored) this.prepareUncapturedPage();
    }

    await authReady;
    this.maybeRunAutoSummary();
  }

  connect = async (tokenPathKey: string) => {
    const cleanTokenPathKey = tokenPathKey.trim();
    if (this.snapshot.authBusy) return false;
    const authEpoch = ++this.authEpoch;
    this.update({ authBusy: true, authError: null });

    try {
      // The auth form is only reachable while disconnected, and its submit is
      // disabled until a key is typed, so a blank key with nothing saved is
      // unreachable. A saved-but-unverified key re-verifies through the same
      // request as a freshly pasted one.
      if (cleanTokenPathKey) await TokenPath.setKey(cleanTokenPathKey);
      if (authEpoch !== this.authEpoch) return false;
      const creditsEpoch = this.beginCreditsObservation();
      const credits = await TokenPath.fetchCredits();
      if (authEpoch !== this.authEpoch) return false;
      this.updateCredits(credits, creditsEpoch);
      this.setConnected(true);
      this.update({ authError: null });
      this.maybeRunAutoSummary();
      return true;
    } catch (error) {
      if (authEpoch !== this.authEpoch) return false;
      if (
        error instanceof TokenPath.Error &&
        (error.status === 401 || error.status === 403)
      ) {
        await TokenPath.clearKey().catch(() => undefined);
        if (authEpoch !== this.authEpoch) return false;
        this.setConnected(false);
        this.update({
          authError:
            "The TokenPath key was rejected. Copy a fresh tpk_… key from platform.tokenpath.ai.",
        });
      } else {
        this.setConnected(false);
        this.update({
          authError:
            error instanceof Error ? error.message : "Couldn't reach TokenPath.",
        });
      }
      return false;
    } finally {
      if (authEpoch === this.authEpoch) this.update({ authBusy: false });
    }
  };

  disconnect = async () => {
    const authEpoch = ++this.authEpoch;
    this.cancelActiveWork();
    this.setConnected(false);
    this.update({ authBusy: true, authError: null });
    // Disconnecting removes the account's footprint on this machine, and the
    // cached chats hold captured page and PDF text, not just the key.
    await clearAll().catch(() => undefined);
    try {
      await TokenPath.clearKey();
    } catch {
      if (authEpoch === this.authEpoch) {
        this.update({
          authError: "Couldn't remove the saved TokenPath key. Try again.",
        });
      }
    } finally {
      if (authEpoch === this.authEpoch) this.update({ authBusy: false });
    }
  };

  submit = (text: string) => {
    const clean = text.trim();
    if (!clean || this.snapshot.busy || !this.snapshot.connected) {
      if (!this.snapshot.connected) {
        this.showToast("Connect TokenPath to start chatting.");
      }
      return false;
    }
    if (!this.context || this.invalidated) {
      void this.captureForSubmission(clean);
      return true;
    }
    void this.runTurn(clean, { echoUser: true });
    return true;
  };

  private async captureForSubmission(text: string) {
    if (this.tabId == null) return;
    this.pendingSubmission = text;
    this.update({
      busy: true,
      contextError: null,
      contextLabel: "Current page",
      contextStatus: "reading",
      contextText: "Reading this page…",
      notice: null,
      sourceType: "page",
    });
    const result = await chrome.runtime
      .sendMessage({ type: "capture-tab-for-chat", tabId: this.tabId })
      .catch(() => ({ ok: false }));
    if (result?.ok === false && this.pendingSubmission === text) {
      this.pendingSubmission = null;
      this.update({
        busy: false,
        contextStatus: "error",
        contextText: "",
        contextError: "TokenPath couldn't access this page.",
      });
      this.addMessage({
        kind: "error",
        role: "assistant",
        text: "TokenPath couldn't access this page.",
      });
    }
  }

  clearHighlights = () => {
    if (
      this.sourceType === "chrome-pdf" &&
      !this.highlightedTarget &&
      !this.pendingPdfHighlight
    ) {
      return;
    }
    if (this.sourceType !== "chrome-pdf" && this.tabId != null) {
      this.highlightEpoch++;
      this.highlightedTarget = null;
      void chrome.runtime
        .sendMessage({
          type: "clear-tab-highlights",
          tabId: this.tabId,
        })
        .then((result) => {
          if (result?.ok !== false) this.showToast("Highlights cleared.");
        })
        .catch(() => undefined);
      return;
    }
    this.highlightEpoch++;
    const pendingPdfHighlight = this.pendingPdfHighlight;
    this.pendingPdfHighlight = null;
    const fallback =
      pendingPdfHighlight?.source ||
      (this.tabId == null
        ? null
        : {
            tabId: this.tabId,
            frameId: this.frameId,
            captureId: this.captureId,
            contextVersion: this.contextVersion,
            sourceType: this.sourceType,
            url: this.sourceUrl,
          });
    void this.clearActiveHighlight(fallback);
  };

  // Stops the request in flight without touching the conversation or the
  // captured context. Whatever the answer had already streamed stays visible,
  // marked incomplete.
  cancelTurn = () => {
    const turnController = this.activeTurnController;
    if (!turnController) return false;
    const messageId = this.activeTurnMessageId;
    // Dropping the cleanup is what separates a cancel from an invalidation:
    // the question and its partial answer both survive.
    this.activeTurnCleanup = null;
    turnController.abort();
    const message = this.snapshot.messages.find(
      (candidate) => candidate.id === messageId
    );
    if (message) {
      if (message.text.trim()) {
        this.updateMessage(message.id, {
          answerStatus: "unavailable",
          attribution: undefined,
          incomplete: true,
        });
      } else {
        // An empty answer bubble carries nothing worth keeping.
        this.removeMessage(message.id);
      }
    }
    this.showToast("Stopped.");
    return true;
  };

  // Runs the summary pathway against the live context using the persistent
  // Short / Medium / Detailed preference.
  runSummary = () => {
    if (this.snapshot.busy) return false;
    if (!this.snapshot.connected) {
      this.showToast("Connect TokenPath to start chatting.");
      return false;
    }
    if (!this.context || this.invalidated) {
      // The only caller is the empty-state starter, which falls back to
      // submit() and captures the page — a toast here would flash a failure
      // over a path that is about to succeed.
      return false;
    }
    const summary = TldrPanelLogic.buildSummaryRequest(
      this.context,
      this.snapshot.summaryLength,
      this.summarySourceKind(),
      this.snapshot.summaryPrompt
    );
    if (summary.skip) {
      this.addMessage({
        kind: "note",
        role: "assistant",
        text:
          this.captureMode === "full-pdf"
            ? "Already concise — ask anything about this PDF."
            : this.captureMode === "video-transcript"
              ? "Already concise — ask anything about this video."
              : this.captureMode === "full-page"
                ? "Already concise — ask anything about this page."
                : "Already concise — ask anything about this selection.",
      });
      return true;
    }
    void this.runTurn(summary.prompt || "", {
      echoUser: false,
      maxOutputTokens: summary.maxOutputTokens,
    });
    return true;
  };

  clearConversation = async () => {
    const key = pageChatKey(this.sourceUrl);
    if (key) await deletePageChat(key).catch(() => undefined);
    this.history = [];
    this.autoSummaryRequested = false;
    this.cancelActiveWork();
    this.cancelHighlightAndClear();
    this.update({
      busy: false,
      messages: [],
      notice: null,
    });
    this.showToast("Chat cleared for this page.");
  };

  dispose = () => {
    if (this.disposed) return;
    this.disposed = true;
    if (this.toastTimer) {
      clearTimeout(this.toastTimer);
      this.toastTimer = null;
    }
    this.cancelActiveWork();
    void this.persistCurrentPageChat();
    this.highlightEpoch++;
    const pendingPdfHighlight = this.pendingPdfHighlight;
    this.pendingPdfHighlight = null;
    // Starting the message here is enough: Chrome owns its delivery even
    // though the side-panel document is being torn down.
    void this.clearActiveHighlight(pendingPdfHighlight?.source || null);
  };

  cycleTheme = () => {
    const next: Record<ThemePreference, ThemePreference> = {
      system: "light",
      light: "dark",
      dark: "system",
    };
    const themePreference = next[this.snapshot.themePreference];
    const resolvedTheme = resolveTheme(themePreference);
    try {
      localStorage.setItem(THEME_KEY, themePreference);
    } catch {
      // Theme still applies for the lifetime of this panel.
    }
    this.applyTheme(resolvedTheme);
    this.update({ themePreference, resolvedTheme });
  };

  setSummaryLength = (summaryLength: SummaryLength) => {
    if (
      summaryLength !== "low" &&
      summaryLength !== "medium" &&
      summaryLength !== "high"
    ) {
      return;
    }
    try {
      localStorage.setItem(SUMMARY_LENGTH_KEY, summaryLength);
    } catch {
      // The in-memory preference still applies for this panel session.
    }
    this.update({
      summaryLength,
      summaryPrompt: this.snapshot.summaryPromptCustomized
        ? this.snapshot.summaryPrompt
        : TldrPanelLogic.defaultSummaryPrompt(summaryLength),
    });
  };

  saveSummaryPrompt = (prompt: string) => {
    const cleanPrompt = prompt
      .trim()
      .slice(0, SUMMARY_PROMPT_MAX_CHARS);
    if (!cleanPrompt) return false;
    try {
      localStorage.setItem(SUMMARY_PROMPT_KEY, cleanPrompt);
    } catch {
      // The custom prompt still applies for the lifetime of this panel.
    }
    this.update({
      summaryPrompt: cleanPrompt,
      summaryPromptCustomized: true,
    });
    this.showToast("Summary prompt saved.");
    return true;
  };

  resetSummaryPrompt = () => {
    const summaryPrompt = TldrPanelLogic.defaultSummaryPrompt(
      this.snapshot.summaryLength
    );
    try {
      localStorage.removeItem(SUMMARY_PROMPT_KEY);
    } catch {
      // Reset still applies for the lifetime of this panel.
    }
    this.update({
      summaryPrompt,
      summaryPromptCustomized: false,
    });
    this.showToast("Default summary prompt restored.");
  };

  onAnswerSelection = async (
    messageId: string,
    answerStart: number,
    answerEnd: number
  ) => {
    const message = this.snapshot.messages.find(
      (candidate) => candidate.id === messageId
    );
    if (!message || message.kind !== "answer" || !message.source) return;
    if (message.attribution?.status === "loading") {
      this.showToast("The source map is still loading.");
      return;
    }
    if (message.attribution?.status !== "ready" || !message.attribution.heatmap) {
      this.showToast(
        message.attribution?.error ||
          "Source attribution is unavailable for this answer."
      );
      return;
    }
    if (
      !Number.isInteger(answerStart) ||
      !Number.isInteger(answerEnd) ||
      answerStart < 0 ||
      answerEnd <= answerStart ||
      answerEnd > message.text.length
    ) {
      return;
    }

    const resolved = TldrPanelLogic.resolveHeatmapSpan(
      message.attribution.heatmap,
      answerStart,
      answerEnd,
      message.attribution.document,
      message.text
    );
    if (!resolved) {
      this.showToast("No source was found for that answer selection.");
      return;
    }
    await this.onAttributionClick(
      resolved.start,
      resolved.end,
      message.source,
      message.attribution.document,
      // Recomputed from the cached heatmap on every click, so a chat restored
      // from a record saved before this existed behaves identically.
      { contextStart: resolved.contextStart, contextEnd: resolved.contextEnd }
    );
  };

  onAttributionClick = async (
    start: number,
    end: number,
    source: HighlightSource,
    documentText = this.context,
    // The wider passage that supports the same selection. Only a video
    // transcript uses it, to start playback where the discussion begins
    // rather than mid-sentence on the cited phrase; the cited span itself is
    // always [start, end).
    supportedRange: { contextStart?: number; contextEnd?: number } = {}
  ) => {
    if (
      source.tabId == null ||
      !Number.isFinite(start) ||
      !Number.isFinite(end)
    ) {
      return;
    }

    const epoch = ++this.highlightEpoch;
    const highlightId = [
      source.captureId || "capture",
      source.contextVersion,
      epoch,
    ].join(":");
    const replacingPdfHighlight =
      source.sourceType === "chrome-pdf" &&
      this.highlightedTarget?.source.sourceType === "chrome-pdf";
    // A PDF text-fragment navigation replaces the previous fragment itself.
    // Clearing first would reload the PDF twice for one attribution click.
    // Keep ownership until the replacement succeeds so Clear still works if
    // Chrome rejects the new navigation.
    if (!replacingPdfHighlight) {
      await this.clearActiveHighlight();
    }
    if (!this.isCurrentHighlight(source, epoch)) return;

    if (source.sourceType === "chrome-pdf") {
      this.pendingPdfHighlight = { id: highlightId, source };
    }
    try {
      const response =
        source.sourceType === "chrome-pdf"
          ? await chrome.runtime.sendMessage({
              type: "highlight-pdf-source",
              tabId: source.tabId,
              url: source.url,
              document: documentText,
              start,
              end,
              highlightId,
            })
          : await chrome.tabs.sendMessage(
              source.tabId,
              {
                type: "highlight",
                start,
                end,
                contextStart: supportedRange.contextStart,
                contextEnd: supportedRange.contextEnd,
                document: documentText,
                captureId: source.captureId,
                highlightId,
              },
              { frameId: source.frameId }
            );
      if (!this.isCurrentHighlight(source, epoch)) {
        // A late DOM response owns a distinct CSS highlight and can safely
        // clear itself. PDF text fragments have no ownership identifier; a
        // late clear could erase a newer PDF highlight.
        if (source.sourceType !== "chrome-pdf") {
          await this.clearHighlightTarget(source, highlightId);
        }
        return;
      }
      if (!(response as { ok?: boolean } | undefined)?.ok) {
        this.showToast(
          source.sourceType === "chrome-pdf"
            ? "Couldn't locate that text in the PDF."
            : "Couldn't locate that text in the page."
        );
        return;
      }
      this.highlightedTarget = { id: highlightId, source };
    } catch {
      if (this.isCurrentHighlight(source, epoch)) {
        this.showToast(
          source.sourceType === "chrome-pdf"
            ? "PDF not reachable (it may have navigated)."
            : "Page not reachable (it may have navigated)."
          );
      }
    } finally {
      if (this.pendingPdfHighlight?.id === highlightId) {
        this.pendingPdfHighlight = null;
      }
    }
  };

  private update(patch: Partial<PanelSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  private handleRuntimeMessage = (message: SelectionSeed) => {
    if (message?.type !== "selection-captured") return;
    if (this.windowId == null) {
      this.earlyCaptures.push(message);
      return;
    }
    if (
      message.windowId != null &&
      message.windowId !== this.windowId
    ) {
      return;
    }
    if (message.tabId != null && message.tabId !== this.tabId) return;
    if (this.applySeed(message) && message.tabId != null) {
      void chrome.storage.session.remove?.(this.seedKey(message.tabId));
    }
  };

  private seedKey(tabId: number) {
    return `seed:${tabId}`;
  }

  private applySeed(seed: SelectionSeed) {
    if (seed.captureId && seed.captureId === this.captureId) return false;
    if (
      Number.isFinite(seed.capturedAt) &&
      Number(seed.capturedAt) < this.capturedAt
    ) {
      return false;
    }

    this.cancelHighlightAndClear();
    this.cancelActiveWork();
    this.autoSummaryRequested = seed.intent === "tldr";
    this.captureId = seed.captureId || null;
    this.capturedAt = Number(seed.capturedAt) || Date.now();
    this.tabId = seed.tabId ?? this.tabId;
    this.frameId = Number.isInteger(seed.frameId) ? Number(seed.frameId) : 0;
    this.sourceType =
      seed.sourceType === "chrome-pdf" ? "chrome-pdf" : "page";
    this.captureMode =
      this.sourceType === "chrome-pdf"
        ? seed.captureMode === "full-pdf"
          ? "full-pdf"
          : "selection"
        : seed.captureMode === "full-page"
          ? "full-page"
          : seed.captureMode === "video-transcript"
            ? "video-transcript"
            : "selection";
    this.sourceUrl = seed.url || null;
    this.sourceBaseUrl = websiteBaseUrl(seed.url);
    this.contextVersion++;
    // A capture supersedes any navigation or tab activation still awaiting its
    // own persist, which would otherwise resume and clobber this context.
    this.navigationEpoch++;
    this.history = [];
    const contextLabel =
      this.captureMode === "full-pdf"
        ? "Entire PDF"
        : this.captureMode === "video-transcript"
          ? "Video transcript"
          : this.captureMode === "full-page"
            ? "Entire page"
            : this.sourceType === "chrome-pdf"
              ? "Selected from PDF"
              : "Selected from page";

    if (seed.error) {
      this.autoSummaryRequested = false;
      const pendingSubmission = this.pendingSubmission;
      this.pendingSubmission = null;
      this.context = "";
      this.update({
        busy: false,
        contextError: "There’s no readable text on this page yet.",
        contextLabel,
        contextStatus: "error",
        contextText: "",
        hasContext: false,
        sourceType: this.contextSourceType(),
        messages: pendingSubmission
          ? [
              ...this.snapshot.messages,
              {
                id: `message-${++this.messageSequence}`,
                kind: "note",
                role: "assistant",
                text:
                  "There’s no readable text on this page yet. If it’s still " +
                  "loading, wait a moment and try again.",
              },
            ]
          : [],
        notice: null,
      });
      return true;
    }
    if (this.captureMode === "full-pdf") {
      this.beginFullPdfCapture(contextLabel);
      return true;
    }
    if (!seed.text) {
      this.autoSummaryRequested = false;
      this.context = "";
      this.update({
        busy: false,
        contextError: "No text was captured.",
        contextLabel,
        contextStatus: "error",
        contextText: "No text was captured.",
        hasContext: false,
        messages: [],
        notice: null,
        sourceType: this.contextSourceType(),
      });
      return true;
    }

    this.activateContext(seed.text, contextLabel, seed.truncated === true, {
      transcriptUnavailable: seed.transcriptUnavailable === true,
    });
    return true;
  }

  /** Which output-headroom tier this context's summaries and answers use. */
  private summarySourceKind() {
    return this.captureMode === "video-transcript" ? "video" : "page";
  }

  private chatOutputTokens() {
    return this.captureMode === "video-transcript"
      ? VIDEO_CHAT_OUTPUT_TOKENS
      : CHAT_OUTPUT_TOKENS;
  }

  private contextSourceType(): ContextSourceType {
    if (this.captureMode === "video-transcript") return "video";
    return this.captureMode === "full-pdf"
      ? "pdf"
      : this.captureMode === "full-page"
        ? "page"
        : "selection";
  }

  private beginFullPdfCapture(contextLabel: string) {
    const sourceUrl = this.sourceUrl;
    if (!sourceUrl) {
      this.autoSummaryRequested = false;
      this.context = "";
      this.update({
        busy: false,
        contextError: "The PDF URL is no longer available.",
        contextLabel,
        contextStatus: "error",
        contextText: "The PDF URL is no longer available.",
        hasContext: false,
        messages: [],
        notice: null,
        sourceType: this.contextSourceType(),
      });
      return;
    }

    const extractionController = new AbortController();
    this.activePdfExtractionController = extractionController;
    const captureId = this.captureId;
    const contextVersion = this.contextVersion;
    this.context = "";
    this.invalidated = false;
    this.update({
      busy: true,
      contextError: null,
      contextLabel,
      contextStatus: "reading",
      contextText: "Reading the full PDF…",
      hasContext: false,
      messages: [],
      notice: null,
      sourceType: this.contextSourceType(),
    });

    void extractPdfText(sourceUrl, {
      signal: extractionController.signal,
    })
      .then(({ text, truncated }) => {
        if (
          extractionController.signal.aborted ||
          this.activePdfExtractionController !== extractionController ||
          captureId !== this.captureId ||
          contextVersion !== this.contextVersion
        ) {
          return;
        }
        this.activePdfExtractionController = null;
        this.activateContext(text, contextLabel, truncated);
      })
      .catch((error: unknown) => {
        if (
          extractionController.signal.aborted ||
          this.activePdfExtractionController !== extractionController ||
          captureId !== this.captureId ||
          contextVersion !== this.contextVersion
        ) {
          return;
        }
        this.activePdfExtractionController = null;
        this.autoSummaryRequested = false;
        this.context = "";
        const contextError =
          error instanceof Error
            ? error.message
            : "Couldn't read the text in this PDF.";
        this.update({
          busy: false,
          contextError,
          contextLabel,
          contextStatus: "error",
          contextText: contextError,
          hasContext: false,
          messages: [],
          notice: null,
          sourceType: this.contextSourceType(),
        });
      });
  }

  private activateContext(
    text: string,
    contextLabel: string,
    truncated = false,
    { transcriptUnavailable = false }: { transcriptUnavailable?: boolean } = {}
  ) {
    this.context = text;
    this.invalidated = false;
    const contextVersion = this.contextVersion;
    this.update({
      busy: false,
      contextError: null,
      contextLabel,
      contextStatus: "ready",
      contextText: text,
      hasContext: true,
      messages: [],
      notice: null,
      sourceType: this.contextSourceType(),
    });
    const pendingSubmission = this.pendingSubmission;
    this.pendingSubmission = null;
    // Notes persist with the chat, so a re-capture restores them; match on a
    // stable prefix (counts drift between captures of a dynamic page) instead
    // of stacking a duplicate.
    const addNoteOnce = (notePrefix: string, text: string) => {
      if (
        this.snapshot.messages.some(
          (message) =>
            message.kind === "note" && message.text.startsWith(notePrefix)
        )
      ) {
        return;
      }
      this.addMessage({ kind: "note", role: "assistant", text });
    };
    const addTruncationNote = () => {
      if (!truncated) return;
      const sourceName =
        this.captureMode === "full-pdf"
          ? "PDF"
          : this.captureMode === "video-transcript"
            ? "transcript"
            : "page";
      const capturedCharacters = Array.from(text).length;
      const notePrefix = `This ${sourceName} is very long`;
      addNoteOnce(
        notePrefix,
        `${notePrefix}, so TokenPath is using its first ` +
          `${capturedCharacters.toLocaleString()} characters.`
      );
    };
    // A video whose captions could not be read is captured as ordinary page
    // text. Saying so is the difference between "attribution is broken" and
    // "this video has no subtitles".
    const addTranscriptFallbackNote = () => {
      if (!transcriptUnavailable) return;
      const notePrefix = "This video has no subtitles";
      addNoteOnce(
        notePrefix,
        `${notePrefix} TokenPath can read, so it captured the page text ` +
          "instead. Answers won't jump to a timestamp."
      );
    };

    // A toolbar TLDR is an explicit request for a fresh one-click result, not
    // a request to reopen the page's cached conversation.
    if (this.autoSummaryRequested) {
      addTranscriptFallbackNote();
      addTruncationNote();
      void this.persistCurrentPageChat();
      this.maybeRunAutoSummary();
      return;
    }

    // The restore replaces the whole message list, so the note has to wait for
    // it. Adding the note first would leave it visible only until the cached
    // chat arrived.
    void this.restorePageChat(text, contextVersion, true).then((restored) => {
      if (contextVersion !== this.contextVersion) return;
      addTranscriptFallbackNote();
      addTruncationNote();
      if (!restored) void this.persistCurrentPageChat();
      if (pendingSubmission) {
        void this.runTurn(pendingSubmission, { echoUser: true });
      }
      this.maybeRunAutoSummary();
    });
  }

  private maybeRunAutoSummary() {
    if (
      !this.autoSummaryRequested ||
      !this.snapshot.connected ||
      this.snapshot.busy ||
      !this.context ||
      this.invalidated
    ) {
      return;
    }
    this.autoSummaryRequested = false;
    this.runSummary();
  }

  private async initAuth() {
    const authEpoch = ++this.authEpoch;
    // Clean up the temporary two-provider build's obsolete secret.
    await chrome.storage.local.remove("openrouterKey").catch(() => undefined);
    const tokenPathAuth = await TokenPath.getAuth();
    if (authEpoch !== this.authEpoch) return;

    const connected = Boolean(tokenPathAuth.key);
    this.setConnected(connected);
    if (!connected) return;

    const creditsEpoch = this.beginCreditsObservation();
    void TokenPath.fetchCredits()
      .then((credits) => {
        if (authEpoch === this.authEpoch && this.snapshot.connected) {
          this.updateCredits(credits, creditsEpoch);
        }
      })
      .catch(async (error) => {
        if (
          authEpoch === this.authEpoch &&
          error instanceof TokenPath.Error &&
          (error.status === 401 || error.status === 403)
        ) {
          await TokenPath.clearKey().catch(() => undefined);
          if (authEpoch !== this.authEpoch) return;
          this.setConnected(false);
          this.update({
            authError:
              "Your saved TokenPath key was rejected — paste a new one.",
          });
        }
      });
  }

  private setConnected(connected: boolean) {
    this.update({
      connected,
      creditsText: connected ? this.snapshot.creditsText : null,
    });
    if (connected) this.maybeRunAutoSummary();
  }

  private beginCreditsObservation() {
    return ++this.creditsEpoch;
  }

  private updateCredits(
    availableTokens: number | null,
    creditsEpoch = this.beginCreditsObservation()
  ) {
    if (
      availableTokens == null ||
      creditsEpoch !== this.creditsEpoch
    ) {
      return;
    }
    this.update({ creditsText: `${formatTokens(availableTokens)} tokens` });
  }

  private async runTurn(
    userText: string,
    {
      echoUser,
      maxOutputTokens,
    }: {
      echoUser: boolean;
      maxOutputTokens?: number;
    }
  ) {
    if (!this.snapshot.connected) {
      this.showToast("Connect TokenPath to start chatting.");
      return;
    }
    // The summary pathway passes its length tier; an ordinary chat turn takes
    // the headroom this context calls for.
    const outputTokens = maxOutputTokens ?? this.chatOutputTokens();

    const historyEntry = echoUser
      ? ({ role: "user", content: userText } as const)
      : null;
    const userMessage = echoUser
      ? this.addMessage({ kind: "text", role: "user", text: userText })
      : null;
    if (historyEntry) this.history.push(historyEntry);

    const context = this.context;
    const contextVersion = this.contextVersion;
    const turnAuthEpoch = this.authEpoch;
    const history = [
      ...this.history,
      ...(echoUser
        ? []
        : [{ role: "user" as const, content: userText }]),
    ];
    const turn = this.buildTurnRequest(context, history);
    const turnController = new AbortController();
    this.activeTurnController?.abort();
    this.activeTurnController = turnController;
    const assistant = this.addMessage({
      answerStatus: "streaming",
      attribution: {
        document: turn.document,
        question: turn.question,
        status: "loading",
      },
      kind: "answer",
      role: "assistant",
      source: {
        tabId: this.tabId,
        frameId: this.frameId,
        captureId: this.captureId,
        contextVersion,
        sourceType: this.sourceType,
        url: this.sourceUrl,
      },
      text: "",
    });
    this.activeTurnMessageId = assistant.id;
    const cleanupCancelledTurn = () => {
      if (contextVersion !== this.contextVersion) return;
      this.removeMessage(assistant.id);
      if (userMessage) this.removeMessage(userMessage.id);
      if (historyEntry) this.removeHistoryEntry(historyEntry);
    };
    this.activeTurnCleanup = cleanupCancelledTurn;
    this.update({ busy: true });

    try {
      const result = await TokenPath.generate({
        messages: turn.messages,
        maxOutputTokens: outputTokens,
        signal: turnController.signal,
        onDelta: (_delta, accumulated) => {
          if (
            turnController.signal.aborted ||
            this.activeTurnController !== turnController ||
            contextVersion !== this.contextVersion
          ) {
            return;
          }
          this.updateMessage(assistant.id, { text: accumulated });
        },
      });
      if (
        turnController.signal.aborted ||
        this.activeTurnController !== turnController ||
        contextVersion !== this.contextVersion
      ) {
        return;
      }

      const answer = result.answer;
      if (!answer.trim()) {
        throw new TokenPath.Error(
          502,
          "empty_response",
          "TokenPath returned an empty answer."
        );
      }

      if (!echoUser) {
        this.history.push({ role: "user", content: userText });
      }
      this.history.push({ role: "assistant", content: answer });
      if (
        turnAuthEpoch === this.authEpoch &&
        this.snapshot.connected &&
        result.creditsRemaining != null
      ) {
        this.updateCredits(result.creditsRemaining);
      }
      this.updateMessage(assistant.id, {
        answerStatus: "attributing",
        attribution: {
          document: turn.document,
          question: turn.question,
          status: "loading",
        },
        text: answer,
      });
      // The answer stopped because it ran out of room, not because the model
      // was done. Unlike a Stop or a broken stream, every word of it is real
      // text the model wrote, so it stays a normal answer and is still
      // attributed — the note only explains why it may end mid-thought.
      if (this.reachedOutputLimit(result.usage, outputTokens)) {
        this.addMessage({
          kind: "note",
          role: "assistant",
          text: this.outputLimitNoteText(echoUser),
        });
      }
      void this.loadHeatmap(assistant.id, contextVersion);
    } catch (error) {
      if (
        turnController.signal.aborted ||
        this.activeTurnController !== turnController ||
        contextVersion !== this.contextVersion
      ) {
        return;
      }
      const partialAnswer =
        error instanceof TokenPath.Error &&
        typeof error.details?.partialAnswer === "string"
          ? error.details.partialAnswer
          : "";
      const failure = await this.generationFailureMessage(error);
      if (
        turnController.signal.aborted ||
        this.activeTurnController !== turnController ||
        contextVersion !== this.contextVersion
      ) {
        return;
      }
      if (partialAnswer.trim()) {
        // The stream delivered real text before it broke. Keep it, marked
        // incomplete, and report the failure alongside it. Attribution is
        // deliberately skipped: a heatmap over a truncated answer would map
        // text the model never finished.
        this.updateMessage(assistant.id, {
          answerStatus: "unavailable",
          attribution: undefined,
          incomplete: true,
          text: partialAnswer,
        });
        this.addMessage({ ...failure, kind: "note" });
        return;
      }
      if (historyEntry) this.removeHistoryEntry(historyEntry);
      this.removeMessage(assistant.id);
      this.addMessage(failure);
    } finally {
      if (this.activeTurnController === turnController) {
        this.activeTurnController = null;
        this.activeTurnCleanup = null;
        this.activeTurnMessageId = null;
        this.update({ busy: false });
        void this.persistCurrentPageChat();
      }
    }
  }

  // TokenPath's terminal event carries no finish reason, so the only evidence
  // that generation was cut short is that it produced every token it was
  // allowed.
  private reachedOutputLimit(
    usage: { output_tokens?: number } | undefined,
    requestedTokens: number
  ) {
    const produced = usage?.output_tokens;
    return (
      Number.isInteger(produced) &&
      Number.isInteger(requestedTokens) &&
      requestedTokens > 0 &&
      (produced as number) >= requestedTokens - OUTPUT_LIMIT_TOLERANCE_TOKENS
    );
  }

  private outputLimitNoteText(echoUser: boolean) {
    if (echoUser) {
      return (
        "This answer reached its output limit, so it may end abruptly. " +
        "Ask a narrower question, or ask for the rest."
      );
    }
    const label = SUMMARY_LENGTH_LABELS[this.snapshot.summaryLength];
    return (
      `This summary reached the ${label} output limit, so it may end ` +
      "abruptly. Choose a longer length, or ask for the rest."
    );
  }

  private async generationFailureMessage(
    error: unknown
  ): Promise<Omit<PanelMessage, "id">> {
    if (!(error instanceof TokenPath.Error)) {
      return {
        kind: "error",
        role: "assistant",
        text: "Something went wrong generating an answer.",
      };
    }
    if (error.status === 401 || error.status === 403) {
      await this.rejectSavedTokenPathKey(
        "Your TokenPath key was rejected — paste a new one."
      );
      return {
        kind: "error",
        role: "assistant",
        text: "Your TokenPath key was rejected. Reconnect to continue.",
      };
    }
    if (error.status === 402) {
      this.updateCreditsAfterInsufficient(error);
      return {
        kind: "error",
        role: "assistant",
        text: "Your TokenPath account has insufficient credits for this request. ",
        link: {
          label: "Top up at platform.tokenpath.ai →",
          href: "https://platform.tokenpath.ai",
        },
      };
    }
    if (error.status === 429) {
      return {
        kind: "error",
        role: "assistant",
        text: "TokenPath is rate-limiting requests — try again in a few seconds.",
      };
    }
    return {
      kind: "error",
      role: "assistant",
      text: error.message || "TokenPath generation failed.",
    };
  }

  private addMessage(message: Omit<PanelMessage, "id">) {
    const next: PanelMessage = {
      ...message,
      id: `message-${++this.messageSequence}`,
    };
    this.update({ messages: [...this.snapshot.messages, next] });
    return next;
  }

  private updateMessage(id: string, patch: Partial<PanelMessage>) {
    let found = false;
    const messages = this.snapshot.messages.map((message) => {
      if (message.id !== id) return message;
      found = true;
      return { ...message, ...patch };
    });
    if (found) this.update({ messages });
    return found;
  }

  private removeMessage(id: string) {
    const messages = this.snapshot.messages.filter(
      (message) => message.id !== id
    );
    if (messages.length !== this.snapshot.messages.length) {
      this.update({ messages });
    }
  }

  private removeHistoryEntry(entry: {
    role: "user" | "assistant";
    content: string;
  }) {
    const index = this.history.indexOf(entry);
    if (index !== -1) this.history.splice(index, 1);
  }

  private buildTurnRequest(
    context: string,
    messages: Array<{
      role: "user" | "assistant";
      content: string;
    }>
  ) {
    const lastUserIndex = messages
      .map((message) => message.role)
      .lastIndexOf("user");
    const question =
      lastUserIndex === -1
        ? "Summarize the selected text."
        : messages[lastUserIndex].content;
    const boundedQuestion = TldrPanelLogic.truncateCodePoints(question, 10_000);
    const systemPrefix =
      `You are given some text from ${this.sourceBaseUrl}. ` +
      "Answer the user's question using the given text as the source of " +
      "truth. Do not invent details that the source does not support. If the " +
      "captured text is too limited to answer meaningfully, say so plainly " +
      "instead of producing a generic explanation.\n\n" +
      "When the user asks for a summary:\n" +
      "- Start with the source's central thesis or purpose in concrete terms.\n" +
      "- Preserve the important claims, recommendations, reasons, examples, " +
      "qualifications, and conclusions needed to understand the source.\n" +
      "- For list or how-to content, retain the distinct takeaways and explain " +
      "what each one means; do not collapse them into vague prose.\n" +
      "- Prefer specific language from the source over generic phrases such " +
      "as 'the text discusses' or 'a specific entity.'\n" +
      "- Make the result useful to someone who has not read the source.\n\n" +
      "Formatting:\n" +
      "- Use concise Markdown.\n" +
      "- Prefer bullet points when they make the answer easier to scan.\n" +
      "- Use a Markdown table when the information is naturally tabular or " +
      "when comparing multiple items.\n" +
      "- Do not force bullets or tables when a short paragraph is clearer.\n\n" +
      "Given text:\n";
    const maxSystemChars = Math.max(
      systemPrefix.length + 2,
      MAX_GENERATE_INPUT_CHARS - boundedQuestion.length
    );
    const document = this.fitDocumentToPrompt(
      context,
      systemPrefix,
      maxSystemChars
    );
    const system = systemPrefix + JSON.stringify(document);

    let remainingChars =
      MAX_GENERATE_INPUT_CHARS - system.length - boundedQuestion.length;
    const priorMessages = messages
      .slice(0, Math.max(0, lastUserIndex))
      .filter((message) => message.content && message.content.trim())
      .slice(-(MAX_GENERATE_MESSAGES - 2));
    const boundedPrior: Array<{
      role: "user" | "assistant";
      content: string;
    }> = [];
    for (
      let index = priorMessages.length - 1;
      index >= 0 && remainingChars > 0;
      index--
    ) {
      const content = TldrPanelLogic.truncateCodePoints(
        priorMessages[index].content,
        Math.min(10_000, remainingChars)
      );
      if (!content) continue;
      boundedPrior.unshift({ role: priorMessages[index].role, content });
      remainingChars -= content.length;
    }

    return {
      document,
      question: boundedQuestion,
      messages: [
        { role: "system" as const, content: system },
        ...boundedPrior,
        { role: "user" as const, content: boundedQuestion },
      ],
    };
  }

  private fitDocumentToPrompt(
    context: string,
    systemPrefix: string,
    maxSystemChars: number
  ) {
    const codePoints = Array.from(context).slice(
      0,
      TokenPath.MAX_DOCUMENT_CHARS
    );
    let low = 0;
    let high = codePoints.length;
    let best = "";
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = codePoints.slice(0, middle).join("");
      const promptLength =
        systemPrefix.length + JSON.stringify(candidate).length;
      if (promptLength <= maxSystemChars) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return best;
  }

  private async loadHeatmap(messageId: string, contextVersion: number) {
    const message = this.snapshot.messages.find(
      (candidate) => candidate.id === messageId
    );
    const attribution = message?.attribution;
    if (!message || !attribution || !message.text) return;

    const controller = new AbortController();
    this.heatmapControllers.set(messageId, controller);
    try {
      const heatmap = await TokenPath.heatmap({
        document: attribution.document,
        question: attribution.question,
        answer: message.text,
        threshold: 0.1,
        signal: controller.signal,
      });
      if (
        controller.signal.aborted ||
        this.heatmapControllers.get(messageId) !== controller ||
        contextVersion !== this.contextVersion
      ) {
        return;
      }
      this.updateMessage(messageId, {
        answerStatus: "ready",
        attribution: {
          ...attribution,
          heatmap,
          status: "ready",
        },
      });
      const creditsAuthEpoch = this.authEpoch;
      const creditsEpoch = this.beginCreditsObservation();
      void TokenPath.fetchCredits()
        .then((credits) => {
          if (
            creditsAuthEpoch === this.authEpoch &&
            this.snapshot.connected
          ) {
            this.updateCredits(credits, creditsEpoch);
          }
        })
        .catch(() => undefined);
    } catch (error) {
      if (
        controller.signal.aborted ||
        this.heatmapControllers.get(messageId) !== controller ||
        contextVersion !== this.contextVersion
      ) {
        return;
      }
      const detail = await this.attributionFailureMessage(error);
      this.updateMessage(messageId, {
        answerStatus: "unavailable",
        attribution: {
          ...attribution,
          error: detail,
          status: "error",
        },
      });
    } finally {
      if (this.heatmapControllers.get(messageId) === controller) {
        this.heatmapControllers.delete(messageId);
      }
      void this.persistCurrentPageChat();
    }
  }

  private async persistCurrentPageChat() {
    const key = pageChatKey(this.sourceUrl);
    if (
      !key ||
      !this.context ||
      // Disconnect wipes the local cache as part of removing the account's
      // footprint; a disconnected panel must not write the in-memory chat
      // straight back on dispose or tab switch.
      !this.snapshot.connected ||
      this.snapshot.busy
    ) {
      return;
    }
    const documents: string[] = [];
    const documentIndexes = new Map<string, number>();
    const messages = this.snapshot.messages.map((message) => {
      const attribution = message.attribution;
      let cachedAttribution: CachedMessageAttribution | undefined;
      if (attribution) {
        let documentIndex = documentIndexes.get(attribution.document);
        if (documentIndex === undefined) {
          documentIndex = documents.length;
          documents.push(attribution.document);
          documentIndexes.set(attribution.document, documentIndex);
        }
        cachedAttribution = {
          documentIndex,
          question: attribution.question,
          status: attribution.status,
          heatmap: attribution.heatmap,
          error: attribution.error,
        };
      }
      return {
        ...message,
        attribution: cachedAttribution,
        source: message.source ? { ...message.source } : undefined,
      };
    });
    const value: CachedPageChat = {
      version: CACHE_FORMAT_VERSION,
      context: this.context,
      contextLabel: this.snapshot.contextLabel,
      captureMode: this.captureMode,
      sourceType: this.sourceType,
      documents,
      history: this.history.map((message) => ({ ...message })),
      messages,
    };
    await writePageChat(key, value).catch(() => undefined);
  }

  private async restorePageChat(
    capturedText: string | null,
    expectedContextVersion: number,
    hasFreshCapture: boolean
  ) {
    const key = pageChatKey(this.sourceUrl);
    if (!key) return false;
    const record = await readPageChat<CachedPageChat>(key).catch(() => null);
    if (
      !record ||
      record.value.version !== CACHE_FORMAT_VERSION ||
      expectedContextVersion !== this.contextVersion
    ) {
      return false;
    }

    const cached = record.value;
    // A fresh capture of a different mode — a selection over a saved
    // full-page chat, or the reverse — is a new conversation subject, not
    // evidence the page changed. Leave the saved record alone; it is only
    // replaced once the user actually sends a turn from the new context.
    if (hasFreshCapture && cached.captureMode !== this.captureMode) {
      return false;
    }
    if (
      capturedText &&
      pageContentSignificantlyChanged(cached.context, capturedText)
    ) {
      await deletePageChat(key).catch(() => undefined);
      if (expectedContextVersion !== this.contextVersion) return false;
      this.update({
        notice:
          "This page has changed significantly since the saved chat. " +
          "TokenPath started a fresh chat with the current content.",
      });
      return false;
    }

    this.context = capturedText || cached.context;
    this.history = cached.history.map((message) => ({ ...message }));
    this.captureMode = cached.captureMode;
    this.sourceType = cached.sourceType;
    this.invalidated = !hasFreshCapture;
    this.messageSequence = Math.max(
      this.messageSequence,
      ...cached.messages.map((message) => {
        const match = /^message-(\d+)$/.exec(message.id);
        return match ? Number(match[1]) : 0;
      })
    );
    const documents = Array.isArray(cached.documents) ? cached.documents : [];
    let normalizedInterruptedAttribution = false;
    const messages: PanelMessage[] = cached.messages.map((message) => {
      const attributionWasInterrupted =
        message.kind === "answer" &&
        (message.answerStatus === "attributing" ||
          message.attribution?.status === "loading");
      if (attributionWasInterrupted) normalizedInterruptedAttribution = true;
      const cachedAttribution = message.attribution;
      // A record whose shared document is missing keeps its answer text; only
      // its source map is lost, exactly like an interrupted attribution.
      const document = cachedAttribution
        ? documents[cachedAttribution.documentIndex]
        : undefined;
      const attributionIsUsable =
        cachedAttribution != null && typeof document === "string";
      return {
        ...message,
        answerStatus:
          attributionWasInterrupted ||
          (cachedAttribution != null && !attributionIsUsable)
            ? ("unavailable" as const)
            : message.answerStatus,
        attribution: attributionIsUsable
          ? {
              document: document as string,
              question: cachedAttribution.question,
              heatmap: cachedAttribution.heatmap,
              ...(attributionWasInterrupted
                ? {
                    error:
                      "Source mapping was interrupted when you left this page.",
                    status: "error" as const,
                  }
                : {
                    error: cachedAttribution.error,
                    status: cachedAttribution.status,
                  }),
            }
          : undefined,
        source: message.source
          ? {
              ...message.source,
              tabId: this.tabId,
              frameId: hasFreshCapture
                ? this.frameId
                : message.source.frameId,
              captureId: hasFreshCapture
                ? this.captureId
                : message.source.captureId,
              contextVersion: this.contextVersion,
              sourceType: this.sourceType,
              url: this.sourceUrl,
            }
          : undefined,
      };
    });
    this.update({
      busy: false,
      contextError: null,
      contextLabel: cached.contextLabel,
      contextStatus: "ready",
      contextText: this.context,
      hasContext: true,
      messages,
      notice: null,
      sourceType: this.contextSourceType(),
    });
    if (normalizedInterruptedAttribution) {
      void this.persistCurrentPageChat();
    }
    return true;
  }

  private async attributionFailureMessage(error: unknown) {
    if (!(error instanceof TokenPath.Error)) {
      return "Source attribution failed for this answer.";
    }
    if (error.status === 401 || error.status === 403) {
      await this.rejectSavedTokenPathKey(
        "Your TokenPath key was rejected — paste a new one."
      );
      return "TokenPath rejected the saved key. Reconnect to map this answer.";
    }
    if (error.status === 402) {
      this.updateCreditsAfterInsufficient(error);
      return "TokenPath credits are insufficient, so this answer has no source map.";
    }
    if (error.status === 429) {
      return "TokenPath is rate-limiting attribution. Try again shortly.";
    }
    return error.message || "Source attribution failed for this answer.";
  }

  private async rejectSavedTokenPathKey(authError: string) {
    const authEpoch = ++this.authEpoch;
    this.setConnected(false);
    this.update({ authBusy: true, authError });
    try {
      await TokenPath.clearKey();
    } catch {
      // Keep the provider disconnected even if extension storage is unavailable.
    } finally {
      if (authEpoch === this.authEpoch) this.update({ authBusy: false });
    }
  }

  private async refreshCredits() {
    const authEpoch = this.authEpoch;
    const creditsEpoch = this.beginCreditsObservation();
    try {
      const credits = await TokenPath.fetchCredits();
      if (
        authEpoch === this.authEpoch &&
        this.snapshot.connected
      ) {
        this.updateCredits(credits, creditsEpoch);
      }
    } catch {
      // The authoritative request error is already visible to the user.
    }
  }

  private updateCreditsAfterInsufficient(error: TokenPathFailure) {
    const available = error.details?.available_tokens;
    if (Number.isInteger(available) && (available as number) >= 0) {
      this.updateCredits(available as number);
      return;
    }
    void this.refreshCredits();
  }

  private isCurrentHighlight(source: HighlightSource, epoch: number) {
    return (
      epoch === this.highlightEpoch &&
      source.contextVersion === this.contextVersion &&
      (this.invalidated || source.captureId === this.captureId)
    );
  }

  private clearHighlightTarget(
    target: HighlightSource | null,
    highlightId: string | null = null
  ) {
    if (!target || target.tabId == null) return Promise.resolve();
    if (target.sourceType === "chrome-pdf") {
      return chrome.runtime
        .sendMessage({
          type: "clear-pdf-source-highlight",
          tabId: target.tabId,
          url: target.url,
          highlightId,
        })
        .then(() => undefined)
        .catch(() => undefined);
    }
    return chrome.tabs
      .sendMessage(
        target.tabId,
        {
          type: "clear-highlight",
          captureId: target.captureId || null,
          highlightId,
        },
        { frameId: target.frameId }
      )
      .then(() => undefined)
      .catch(() => undefined);
  }

  private async clearActiveHighlight(fallback: HighlightSource | null = null) {
    const active = this.highlightedTarget;
    this.highlightedTarget = null;
    await this.clearHighlightTarget(
      active?.source || fallback,
      active?.id || null
    );
  }

  private cancelHighlightAndClear() {
    this.highlightEpoch++;
    const pendingPdfHighlight = this.pendingPdfHighlight;
    this.pendingPdfHighlight = null;
    void this.clearActiveHighlight(pendingPdfHighlight?.source || null);
  }

  private cancelActiveWork() {
    const wasExtractingPdf = Boolean(this.activePdfExtractionController);
    this.activePdfExtractionController?.abort();
    this.activePdfExtractionController = null;
    const cleanupTurn = this.activeTurnCleanup;
    this.activeTurnController?.abort();
    this.activeTurnController = null;
    this.activeTurnCleanup = null;
    cleanupTurn?.();
    for (const [messageId, controller] of this.heatmapControllers) {
      controller.abort();
      const message = this.snapshot.messages.find(
        (candidate) => candidate.id === messageId
      );
      if (message?.attribution?.status === "loading") {
        this.updateMessage(messageId, {
          answerStatus: "unavailable",
          attribution: {
            ...message.attribution,
            error: "Source attribution was cancelled.",
            status: "error",
          },
        });
      }
    }
    this.heatmapControllers.clear();
    if (this.snapshot.busy) {
      this.update({
        busy: false,
        ...(wasExtractingPdf && !this.context
          ? {
              contextError: "PDF reading was cancelled.",
              contextStatus: "error" as const,
              contextText: "PDF reading was cancelled.",
            }
          : {}),
      });
    }
  }

  private watchTab() {
    chrome.tabs.onActivated?.addListener((activeInfo) => {
      if (
        activeInfo.tabId === this.tabId &&
        activeInfo.windowId === this.windowId
      ) {
        return;
      }
      void this.handleTabActivation(activeInfo.tabId, activeInfo.windowId);
    });
    chrome.tabs.onUpdated.addListener((id, changeInfo) => {
      if (id !== this.tabId || !changeInfo.url) return;
      // A fragment-only change is scroll position, not navigation: a plain
      // "#section" anchor, our own ":~:text=" attribution directive, and the
      // native PDF viewer's #page/#zoom parameters all leave the captured
      // document — and therefore the chat — intact.
      if (sameDocumentUrl(changeInfo.url, this.sourceUrl)) return;
      void this.handlePageNavigation(changeInfo.url);
    });
    chrome.tabs.onRemoved.addListener((id) => {
      if (id === this.tabId) this.invalidate("The tab was closed.", false);
    });
  }

  private async handleTabActivation(tabId: number, windowId: number) {
    const navigationEpoch = ++this.navigationEpoch;
    await this.persistCurrentPageChat();
    if (navigationEpoch !== this.navigationEpoch) return;

    this.cancelHighlightAndClear();
    this.cancelActiveWork();
    this.invalidated = true;
    this.context = "";
    this.history = [];
    this.contextVersion++;
    this.tabId = tabId;
    this.windowId = windowId;
    this.frameId = 0;
    this.captureId = null;
    this.captureMode = "selection";
    this.update({
      busy: false,
      contextError: null,
      contextLabel: "Current page",
      contextStatus: "idle",
      contextText: "",
      hasContext: false,
      messages: [],
      notice: null,
      sourceType: "page",
    });

    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (
      !tab ||
      navigationEpoch !== this.navigationEpoch ||
      tabId !== this.tabId
    ) {
      return;
    }
    this.sourceUrl = tab.url || null;
    this.sourceBaseUrl = websiteBaseUrl(this.sourceUrl);
    const restored = await this.restorePageChat(
      null,
      this.contextVersion,
      false
    );
    if (!restored && navigationEpoch === this.navigationEpoch) {
      this.prepareUncapturedPage();
    }
  }

  private async handlePageNavigation(url: string) {
    const navigationEpoch = ++this.navigationEpoch;
    await this.persistCurrentPageChat();
    if (navigationEpoch !== this.navigationEpoch) return;
    this.invalidate("", false);
    this.sourceUrl = url;
    this.sourceBaseUrl = websiteBaseUrl(url);
    this.captureId = null;
    this.contextVersion++;
    const restored = await this.restorePageChat(
      null,
      this.contextVersion,
      false
    );
    if (!restored && navigationEpoch === this.navigationEpoch) {
      this.prepareUncapturedPage();
    }
  }

  private prepareUncapturedPage() {
    this.invalidated = true;
    this.context = "";
    this.history = [];
    this.autoSummaryRequested = false;
    this.pendingSubmission = null;
    this.update({
      busy: false,
      contextError: null,
      contextLabel: "Current page",
      contextStatus: "idle",
      contextText: "",
      hasContext: false,
      messages: [],
      notice: null,
      sourceType: "page",
    });
  }

  private invalidate(reason: string, clearHighlight = true) {
    this.invalidated = true;
    this.context = "";
    this.history = [];
    this.autoSummaryRequested = false;
    this.contextVersion++;
    this.highlightEpoch++;
    const pendingPdfHighlight = this.pendingPdfHighlight;
    this.pendingPdfHighlight = null;
    if (clearHighlight) {
      void this.clearActiveHighlight(pendingPdfHighlight?.source || null);
    } else {
      // The source tab has already left the captured document (or no longer
      // exists). A PDF clear is itself a navigation, so never send it here.
      this.highlightedTarget = null;
      if (this.sourceType === "chrome-pdf" && this.tabId != null) {
        void chrome.runtime
          .sendMessage({
            type: "cancel-pdf-source-operation",
            tabId: this.tabId,
          })
          .catch(() => undefined);
      }
    }
    this.cancelActiveWork();
    this.update({
      busy: false,
      contextError: reason || null,
      contextLabel: "Current page",
      contextStatus: reason ? "error" : "idle",
      contextText: reason,
      hasContext: false,
      messages: [],
      notice: null,
      sourceType: "page",
    });
  }

  private showToast(text: string) {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    // The sequence number lets the view re-announce a repeated identical
    // toast, which an unchanged text node would silently swallow.
    this.update({ toast: text, toastSeq: this.snapshot.toastSeq + 1 });
    this.toastTimer = setTimeout(() => {
      this.toastTimer = null;
      this.update({ toast: null });
    }, 2600);
  }

  private watchSystemTheme() {
    this.mediaQuery = window.matchMedia?.("(prefers-color-scheme: dark)") ?? null;
    this.mediaQuery?.addEventListener("change", () => {
      if (this.snapshot.themePreference !== "system") return;
      const resolvedTheme = systemTheme();
      this.applyTheme(resolvedTheme);
      this.update({ resolvedTheme });
    });
  }

  private applyTheme(theme: ResolvedTheme) {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
  }
}
