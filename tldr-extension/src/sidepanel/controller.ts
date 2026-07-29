import { extractPdfText } from "@/pdf-text-extractor";
import {
  deletePageChat,
  pageChatKey,
  pageContentSignificantlyChanged,
  readPageChat,
  writePageChat,
} from "@/chat-cache";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";
export type SummaryLength = "low" | "medium" | "high";
export type SourceType = "page" | "chrome-pdf";
export type CaptureMode = "selection" | "full-page" | "full-pdf";
export type CaptureIntent = "tldr" | "simplify" | "ask";

export interface SelectionSeed {
  type?: string;
  captureId?: string | null;
  capturedAt?: number;
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
  contextLabel: string;
  contextText: string;
  creditsText: string | null;
  hasContext: boolean;
  messages: PanelMessage[];
  notice: string | null;
  resolvedTheme: ResolvedTheme;
  summaryLength: SummaryLength;
  themePreference: ThemePreference;
  tokenPathReady: boolean;
  toast: string | null;
}

type SummaryRequest = TldrSummaryRequest;
type AutomaticRequest = SummaryRequest & {
  intent: Exclude<CaptureIntent, "ask">;
};

interface CachedPageChat {
  version: 1;
  context: string;
  contextLabel: string;
  captureMode: CaptureMode;
  sourceType: SourceType;
  history: Array<{ role: "user" | "assistant"; content: string }>;
  messages: PanelMessage[];
}

const THEME_KEY = "tldr-theme";
const SUMMARY_LENGTH_KEY = "tldr-summary-length";
const MAX_GENERATE_INPUT_CHARS = 420_000;
const MAX_GENERATE_MESSAGES = 50;
const CHAT_OUTPUT_TOKENS = 512;
const SIMPLIFY_OUTPUT_TOKENS = 768;
const SIMPLIFY_PROMPT =
  "Rewrite and explain the given text in clear, simple language. Keep the " +
  "explanation concise while preserving all facts, meaning, and " +
  "qualifications. Do not add any information that is not present in the " +
  "text. Return only the rewritten explanation.";

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

function samePdfDocumentUrl(
  candidateUrl: string,
  sourceUrl: string | null
) {
  if (!sourceUrl) return false;
  try {
    const candidate = new URL(candidateUrl);
    const source = new URL(sourceUrl);
    // Page/zoom anchors and our :~:text directive only change the native
    // viewer's viewport. The PDF response itself is still the same source.
    candidate.hash = "";
    source.hash = "";
    return candidate.href === source.href;
  } catch {
    return candidateUrl.split("#", 1)[0] === sourceUrl.split("#", 1)[0];
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
  private captureIntent: CaptureIntent = "tldr";
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
  private pendingAutoSummary: AutomaticRequest | null = null;
  private pendingSubmission: string | null = null;
  private messageSequence = 0;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private disposed = false;
  private mediaQuery: MediaQueryList | null = null;
  private activeTurnController: AbortController | null = null;
  private activeTurnCleanup: (() => void) | null = null;
  private activePdfExtractionController: AbortController | null = null;
  private heatmapControllers = new Map<string, AbortController>();
  private navigationEpoch = 0;

  constructor() {
    const themePreference = readThemePreference();
    const resolvedTheme = resolveTheme(themePreference);
    const summaryLength = readSummaryLength();
    this.snapshot = {
      authBusy: false,
      authError: null,
      busy: false,
      connected: false,
      contextLabel: "Current page",
      contextText: "",
      creditsText: null,
      hasContext: false,
      messages: [],
      notice: null,
      resolvedTheme,
      summaryLength,
      themePreference,
      tokenPathReady: false,
      toast: null,
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
        seeded = this.applySeed(seed);
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
      const savedTokenPath = await TokenPath.getAuth();
      if (authEpoch !== this.authEpoch) return false;
      const effectiveTokenPathKey =
        cleanTokenPathKey || savedTokenPath.key || "";
      if (!effectiveTokenPathKey) {
        this.update({
          authError: "Add a TokenPath API key.",
        });
        return false;
      }

      if (cleanTokenPathKey) await TokenPath.setKey(cleanTokenPathKey);
      if (authEpoch !== this.authEpoch) return false;
      const creditsEpoch = this.beginCreditsObservation();
      const credits = await TokenPath.fetchCredits();
      if (authEpoch !== this.authEpoch) return false;
      this.updateCredits(credits, creditsEpoch);
      this.setTokenPathReady(true);
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
        this.setTokenPathReady(false);
        this.update({
          authError:
            "The TokenPath key was rejected. Copy a fresh tpk_… key from platform.tokenpath.ai.",
        });
      } else {
        this.setTokenPathReady(false);
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
    this.setTokenPathReady(false);
    this.update({ authBusy: true, authError: null });
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
      contextLabel: "Current page",
      contextText: "Reading this page…",
      notice: null,
    });
    const result = await chrome.runtime
      .sendMessage({ type: "capture-tab-for-chat", tabId: this.tabId })
      .catch(() => ({ ok: false }));
    if (result?.ok === false && this.pendingSubmission === text) {
      this.pendingSubmission = null;
      this.update({ busy: false, contextText: "" });
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

  clearConversation = async () => {
    const key = pageChatKey(this.sourceUrl);
    if (key) await deletePageChat(key).catch(() => undefined);
    this.history = [];
    this.pendingAutoSummary = null;
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
    if (
      this.pendingAutoSummary?.intent === "tldr" &&
      this.context
    ) {
      this.pendingAutoSummary = {
        ...TldrPanelLogic.buildSummaryRequest(this.context, summaryLength),
        intent: "tldr",
      };
    }
    this.update({ summaryLength });
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
      message.source
    );
  };

  onAttributionClick = async (
    start: number,
    end: number,
    source: HighlightSource
  ) => {
    if (this.invalidated) {
      this.showToast(
        "The page navigated — re-select and choose a TokenPath action again."
      );
      return;
    }
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
              document: this.context,
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
          : "selection";
    this.captureIntent =
      seed.intent === "simplify" || seed.intent === "ask"
        ? seed.intent
        : "tldr";
    this.sourceUrl = seed.url || null;
    this.sourceBaseUrl = websiteBaseUrl(seed.url);
    this.contextVersion++;
    this.history = [];
    this.pendingAutoSummary = null;
    const contextLabel =
      this.captureMode === "full-pdf"
        ? "Entire PDF"
        : this.captureMode === "full-page"
          ? "Entire page"
          : this.sourceType === "chrome-pdf"
            ? "Selected from PDF"
            : "Selected from page";

    if (seed.error) {
      const pendingSubmission = this.pendingSubmission;
      this.pendingSubmission = null;
      this.context = "";
      this.update({
        busy: false,
        contextLabel,
        contextText: "",
        hasContext: false,
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
      this.context = "";
      this.update({
        busy: false,
        contextLabel,
        contextText: "No text was captured.",
        hasContext: false,
        messages: [],
        notice: null,
      });
      return true;
    }

    this.activateContext(
      seed.text,
      contextLabel,
      seed.truncated === true,
      this.captureIntent
    );
    return true;
  }

  private beginFullPdfCapture(contextLabel: string) {
    const sourceUrl = this.sourceUrl;
    if (!sourceUrl) {
      this.context = "";
      this.update({
        busy: false,
        contextLabel,
        contextText: "The PDF URL is no longer available.",
        hasContext: false,
        messages: [],
        notice: null,
      });
      return;
    }

    const extractionController = new AbortController();
    this.activePdfExtractionController = extractionController;
    const captureId = this.captureId;
    const contextVersion = this.contextVersion;
    const captureIntent = this.captureIntent;
    this.context = "";
    this.invalidated = false;
    this.update({
      busy: true,
      contextLabel,
      contextText: "Reading the full PDF…",
      hasContext: false,
      messages: [],
      notice: null,
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
        this.activateContext(
          text,
          contextLabel,
          truncated,
          captureIntent
        );
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
        this.context = "";
        this.update({
          busy: false,
          contextLabel,
          contextText:
            error instanceof Error
              ? error.message
              : "Couldn't read the text in this PDF.",
          hasContext: false,
          messages: [],
          notice: null,
        });
      });
  }

  private activateContext(
    text: string,
    contextLabel: string,
    truncated = false,
    intent: CaptureIntent = this.captureIntent
  ) {
    this.context = text;
    this.invalidated = false;
    this.update({
      busy: false,
      contextLabel,
      contextText: text,
      hasContext: true,
      messages: [],
      notice: null,
    });
    const pendingSubmission = this.pendingSubmission;
    this.pendingSubmission = null;
    if (intent === "ask") {
      void this.restorePageChat(text, this.contextVersion, true).then(
        (restored) => {
          if (!restored) void this.persistCurrentPageChat();
          if (pendingSubmission) {
            void this.runTurn(pendingSubmission, { echoUser: true });
          }
        }
      );
    }
    if (truncated) {
      const sourceName =
        this.captureMode === "full-pdf" ? "PDF" : "page";
      const capturedCharacters = Array.from(text).length;
      this.addMessage({
        kind: "note",
        role: "assistant",
        text:
          `This ${sourceName} is very long, so TokenPath is using its first ` +
          `${capturedCharacters.toLocaleString()} characters.`,
      });
    }

    if (intent === "ask") return;
    if (intent === "simplify") {
      this.pendingAutoSummary = {
        intent: "simplify",
        maxOutputTokens: SIMPLIFY_OUTPUT_TOKENS,
        prompt: SIMPLIFY_PROMPT,
        skip: false,
      };
      this.maybeRunAutoSummary();
      return;
    }

    const summary = TldrPanelLogic.buildSummaryRequest(
      text,
      this.snapshot.summaryLength
    );
    if (summary.skip) {
      this.addMessage({
        kind: "note",
        role: "assistant",
        text:
          this.captureMode === "full-pdf"
            ? "Already concise — ask anything about this PDF."
            : this.captureMode === "full-page"
              ? "Already concise — ask anything about this page."
              : "Already concise — ask anything about this selection.",
      });
      return;
    }
    this.pendingAutoSummary = { ...summary, intent: "tldr" };
    this.maybeRunAutoSummary();
  }

  private async initAuth() {
    const authEpoch = ++this.authEpoch;
    // Clean up the temporary two-provider build's obsolete secret.
    await chrome.storage.local.remove("openrouterKey").catch(() => undefined);
    const tokenPathAuth = await TokenPath.getAuth();
    if (authEpoch !== this.authEpoch) return;

    const tokenPathReady = Boolean(tokenPathAuth.key);
    this.setTokenPathReady(tokenPathReady);
    if (!tokenPathReady) return;

    const creditsEpoch = this.beginCreditsObservation();
    void TokenPath.fetchCredits()
      .then((credits) => {
        if (authEpoch === this.authEpoch && this.snapshot.tokenPathReady) {
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
          this.setTokenPathReady(false);
          this.update({
            authError:
              "Your saved TokenPath key was rejected — paste a new one.",
          });
        }
      });
  }

  private setTokenPathReady(tokenPathReady: boolean) {
    this.update({
      connected: tokenPathReady,
      tokenPathReady,
      creditsText: tokenPathReady ? this.snapshot.creditsText : null,
    });
    if (tokenPathReady) this.maybeRunAutoSummary();
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

  private maybeRunAutoSummary() {
    if (
      !this.snapshot.connected ||
      this.snapshot.busy ||
      !this.context ||
      !this.pendingAutoSummary
    ) {
      return;
    }
    const summary = this.pendingAutoSummary;
    this.pendingAutoSummary = null;
    void this.runTurn(summary.prompt || "", {
      echoUser: false,
      summary,
    });
  }

  private async runTurn(
    userText: string,
    {
      echoUser,
      summary = null,
    }: {
      echoUser: boolean;
      summary?: AutomaticRequest | null;
    }
  ) {
    if (!this.snapshot.connected) {
      if (summary) this.pendingAutoSummary = summary;
      this.showToast("Connect TokenPath to start chatting.");
      return;
    }

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
        maxOutputTokens: summary?.maxOutputTokens ?? CHAT_OUTPUT_TOKENS,
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
        this.snapshot.tokenPathReady &&
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
      void this.loadHeatmap(assistant.id, contextVersion);
    } catch (error) {
      if (
        turnController.signal.aborted ||
        this.activeTurnController !== turnController ||
        contextVersion !== this.contextVersion
      ) {
        return;
      }
      if (historyEntry) this.removeHistoryEntry(historyEntry);
      this.removeMessage(assistant.id);
      const failure = await this.generationFailureMessage(error);
      if (
        turnController.signal.aborted ||
        this.activeTurnController !== turnController ||
        contextVersion !== this.contextVersion
      ) {
        return;
      }
      this.addMessage(failure);
    } finally {
      if (this.activeTurnController === turnController) {
        this.activeTurnController = null;
        this.activeTurnCleanup = null;
        this.update({ busy: false });
        void this.persistCurrentPageChat();
        this.maybeRunAutoSummary();
      }
    }
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
            this.snapshot.tokenPathReady
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
      this.snapshot.busy
    ) {
      return;
    }
    const value: CachedPageChat = {
      version: 1,
      context: this.context,
      contextLabel: this.snapshot.contextLabel,
      captureMode: this.captureMode,
      sourceType: this.sourceType,
      history: this.history.map((message) => ({ ...message })),
      messages: this.snapshot.messages.map((message) => ({
        ...message,
        attribution: message.attribution
          ? { ...message.attribution }
          : undefined,
        source: message.source ? { ...message.source } : undefined,
      })),
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
      record.value.version !== 1 ||
      expectedContextVersion !== this.contextVersion
    ) {
      return false;
    }

    const cached = record.value;
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
    const messages = cached.messages.map((message) => ({
      ...message,
      attribution: message.attribution
        ? { ...message.attribution }
        : undefined,
      source:
        hasFreshCapture && message.source
          ? {
              ...message.source,
              tabId: this.tabId,
              frameId: this.frameId,
              captureId: this.captureId,
              contextVersion: this.contextVersion,
              sourceType: this.sourceType,
              url: this.sourceUrl,
            }
          : undefined,
    }));
    const hasConversation = messages.some(
      (message) => message.kind !== "note"
    );
    this.update({
      busy: false,
      contextLabel: cached.contextLabel,
      contextText: this.context,
      hasContext: true,
      messages,
      notice: hasConversation
        ? hasFreshCapture
          ? "Restored the saved chat for this page."
          : "Restored the saved chat for this page. Reopen TokenPath on the " +
            "page to re-enable source highlighting."
        : null,
    });
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
    this.setTokenPathReady(false);
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
        this.snapshot.tokenPathReady
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
      !this.invalidated &&
      source.contextVersion === this.contextVersion &&
      source.captureId === this.captureId
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
          ? { contextText: "PDF reading was cancelled." }
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
      if (
        this.sourceType === "chrome-pdf" &&
        samePdfDocumentUrl(changeInfo.url, this.sourceUrl)
      ) {
        return;
      }
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
    this.pendingAutoSummary = null;
    this.contextVersion++;
    this.tabId = tabId;
    this.windowId = windowId;
    this.frameId = 0;
    this.captureId = null;
    this.update({
      busy: false,
      contextLabel: "Current page",
      contextText: "",
      hasContext: false,
      messages: [],
      notice: null,
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
    this.pendingAutoSummary = null;
    this.pendingSubmission = null;
    this.update({
      busy: false,
      contextLabel: "Current page",
      contextText: "",
      hasContext: false,
      messages: [],
      notice: null,
    });
  }

  private invalidate(reason: string, clearHighlight = true) {
    this.invalidated = true;
    this.context = "";
    this.history = [];
    this.pendingAutoSummary = null;
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
      contextLabel: "Current page",
      contextText: reason,
      hasContext: false,
      messages: [],
      notice: null,
    });
  }

  private showToast(text: string) {
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.update({ toast: text });
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
