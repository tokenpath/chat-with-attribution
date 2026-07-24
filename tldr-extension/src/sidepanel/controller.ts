export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export interface SelectionSeed {
  type?: string;
  captureId?: string | null;
  capturedAt?: number;
  tabId?: number | null;
  windowId?: number | null;
  frameId?: number;
  text?: string;
  error?: string;
}

export interface HighlightSource {
  tabId: number | null;
  frameId: number;
  captureId: string | null;
  contextVersion: number;
}

export interface PanelMessage {
  id: string;
  role: "user" | "assistant";
  kind: "text" | "answer" | "note" | "error";
  text: string;
  attributions?: TldrAttribution[];
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
  contextText: string;
  creditsText: string | null;
  hasContext: boolean;
  messages: PanelMessage[];
  notice: string | null;
  resolvedTheme: ResolvedTheme;
  themePreference: ThemePreference;
  toast: string | null;
}

interface SummaryRequest extends TldrSummaryRequest {
  skip: boolean;
}

const THEME_KEY = "tldr-theme";

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
  private context = "";
  private history: Array<{
    role: "user" | "assistant";
    content: string;
  }> = [];
  private invalidated = false;
  private contextVersion = 0;
  private authEpoch = 0;
  private highlightEpoch = 0;
  private highlightedTarget: HighlightSource | null = null;
  private pendingAutoSummary: SummaryRequest | null = null;
  private messageSequence = 0;
  private toastTimer: ReturnType<typeof setTimeout> | null = null;
  private mediaQuery: MediaQueryList | null = null;

  constructor() {
    const themePreference = readThemePreference();
    const resolvedTheme = resolveTheme(themePreference);
    this.snapshot = {
      authBusy: false,
      authError: null,
      busy: false,
      connected: false,
      contextText: "Waiting for a selection…",
      creditsText: null,
      hasContext: false,
      messages: [],
      notice: null,
      resolvedTheme,
      themePreference,
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
    if (earlyCapture) this.applySeed(earlyCapture);

    if (this.tabId != null) {
      const key = this.seedKey(this.tabId);
      const stored = await chrome.storage.session.get(key);
      const seed = stored[key] as SelectionSeed | undefined;
      if (seed) this.applySeed(seed);
    }

    await authReady;
    this.maybeRunAutoSummary();
  }

  connect = async (key: string) => {
    const cleanKey = key.trim();
    if (!cleanKey || this.snapshot.authBusy) return false;
    const authEpoch = ++this.authEpoch;
    this.update({ authBusy: true, authError: null });

    try {
      await TokenPath.setKey(cleanKey);
      const credits = await TokenPath.fetchCredits();
      if (authEpoch !== this.authEpoch) return false;
      this.updateCredits(credits);
    } catch (error) {
      if (authEpoch !== this.authEpoch) return false;
      await TokenPath.clearKey();
      const message =
        error instanceof TokenPath.Error &&
        (error.status === 401 || error.status === 403)
          ? "That key was rejected. Copy a fresh tpk_… key from platform.tokenpath.ai."
          : error instanceof Error
            ? error.message
            : "Couldn't reach TokenPath.";
      this.update({ authBusy: false, authError: message });
      return false;
    }

    this.update({ authBusy: false, authError: null });
    this.setConnected(true);
    this.maybeRunAutoSummary();
    return true;
  };

  disconnect = async () => {
    this.authEpoch++;
    await TokenPath.clearKey();
    this.setConnected(false);
  };

  submit = (text: string) => {
    const clean = text.trim();
    if (
      !clean ||
      this.snapshot.busy ||
      !this.context ||
      !this.snapshot.connected
    ) {
      if (!this.snapshot.connected) {
        this.showToast("Connect TokenPath to start chatting.");
      }
      return false;
    }
    void this.runTurn(clean, { echoUser: true });
    return true;
  };

  clearHighlights = () => {
    this.highlightEpoch++;
    const fallback =
      this.tabId == null
        ? null
        : {
            tabId: this.tabId,
            frameId: this.frameId,
            captureId: this.captureId,
            contextVersion: this.contextVersion,
          };
    void this.clearActiveHighlight(fallback);
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

  onAttributionClick = async (
    start: number,
    end: number,
    source: HighlightSource
  ) => {
    if (this.invalidated) {
      this.showToast("The page navigated — re-select and choose TLDR again.");
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
    await this.clearActiveHighlight();
    if (!this.isCurrentHighlight(source, epoch)) return;

    try {
      const response = await chrome.tabs.sendMessage(
        source.tabId,
        {
          type: "highlight",
          start,
          end,
          captureId: source.captureId,
        },
        { frameId: source.frameId }
      );
      if (!this.isCurrentHighlight(source, epoch)) {
        await this.clearHighlightTarget(source);
        return;
      }
      if (!(response as { ok?: boolean } | undefined)?.ok) {
        this.showToast("Couldn't locate that text in the page.");
        return;
      }
      this.highlightedTarget = source;
    } catch {
      if (this.isCurrentHighlight(source, epoch)) {
        this.showToast("Page not reachable (it may have navigated).");
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
    this.applySeed(message);
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
    this.captureId = seed.captureId || null;
    this.capturedAt = Number(seed.capturedAt) || Date.now();
    this.tabId = seed.tabId ?? this.tabId;
    this.frameId = Number.isInteger(seed.frameId) ? Number(seed.frameId) : 0;
    this.contextVersion++;
    this.history = [];
    this.pendingAutoSummary = null;

    if (seed.error) {
      this.context = "";
      this.update({
        contextText: seed.error,
        hasContext: false,
        messages: [],
        notice: null,
      });
      return true;
    }
    if (!seed.text) {
      this.context = "";
      this.update({
        contextText: "No text was captured.",
        hasContext: false,
        messages: [],
        notice: null,
      });
      return true;
    }

    this.context = seed.text;
    this.invalidated = false;
    this.update({
      contextText: seed.text,
      hasContext: true,
      messages: [],
      notice: null,
    });

    const summary = TldrPanelLogic.buildSummaryRequest(seed.text);
    if (summary.skip) {
      this.addMessage({
        kind: "note",
        role: "assistant",
        text: "Already concise — ask anything about this selection.",
      });
      return true;
    }
    this.pendingAutoSummary = summary;
    this.maybeRunAutoSummary();
    return true;
  }

  private async initAuth() {
    const authEpoch = ++this.authEpoch;
    const { key } = await TokenPath.getAuth();
    if (authEpoch !== this.authEpoch) return;
    if (!key) {
      this.setConnected(false);
      return;
    }

    this.setConnected(true);
    void TokenPath.fetchCredits()
      .then((credits) => {
        if (authEpoch === this.authEpoch) this.updateCredits(credits);
      })
      .catch(async (error) => {
        if (
          authEpoch === this.authEpoch &&
          error instanceof TokenPath.Error &&
          (error.status === 401 || error.status === 403)
        ) {
          await TokenPath.clearKey();
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

  private updateCredits(availableTokens: number | null) {
    if (availableTokens == null) return;
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
      maxOutputTokens: summary.maxOutputTokens,
    });
  }

  private async runTurn(
    userText: string,
    {
      echoUser,
      summary = null,
      maxOutputTokens = null,
    }: {
      echoUser: boolean;
      summary?: SummaryRequest | null;
      maxOutputTokens?: number | null;
    }
  ) {
    if (!this.snapshot.connected) {
      if (summary) this.pendingAutoSummary = summary;
      this.showToast("Connect TokenPath to start chatting.");
      return;
    }

    if (echoUser) {
      this.history.push({ role: "user", content: userText });
      this.addMessage({ kind: "text", role: "user", text: userText });
    }

    const context = this.context;
    const contextVersion = this.contextVersion;
    const history = [
      ...this.history,
      ...(echoUser
        ? []
        : [{ role: "user" as const, content: userText }]),
    ];
    this.update({ busy: true });

    let result:
      | Awaited<ReturnType<TokenPathApi["answer"]>>
      | null = null;
    let failure: unknown = null;
    try {
      result = await this.askLLM(context, history, { maxOutputTokens });
    } catch (error) {
      failure = error;
    }

    if (contextVersion !== this.contextVersion) {
      this.update({ busy: false });
      this.maybeRunAutoSummary();
      return;
    }

    if (failure) {
      if (echoUser) this.history.pop();
      await this.renderFailure(failure);
    } else if (result) {
      const answer = summary
        ? TldrPanelLogic.enforceShorterSummary(
            result.answer,
            context,
            summary.maxUnits ?? null
          )
        : result.answer;
      this.history.push({ role: "assistant", content: answer });
      this.addMessage({
        attributions:
          answer === result.answer ? result.attributions || [] : [],
        kind: "answer",
        role: "assistant",
        source: {
          tabId: this.tabId,
          frameId: this.frameId,
          captureId: this.captureId,
          contextVersion: this.contextVersion,
        },
        text: answer,
      });
      this.updateCredits(result.creditsRemaining);
    }

    this.update({ busy: false });
    this.maybeRunAutoSummary();
  }

  private async renderFailure(error: unknown) {
    if (!(error instanceof TokenPath.Error)) {
      this.addMessage({
        kind: "error",
        role: "assistant",
        text: "Something went wrong generating an answer.",
      });
      return;
    }
    if (error.status === 401 || error.status === 403) {
      const authEpoch = ++this.authEpoch;
      await TokenPath.clearKey();
      if (authEpoch !== this.authEpoch) return;
      this.setConnected(false);
      this.update({
        authError: "Your TokenPath key was rejected — paste a new one.",
      });
      this.addMessage({
        kind: "error",
        role: "assistant",
        text: "Your TokenPath key was rejected. Reconnect to continue.",
      });
      return;
    }
    if (error.status === 402) {
      this.addMessage({
        kind: "error",
        role: "assistant",
        text: "You're out of TokenPath credits. ",
        link: {
          label: "Top up at platform.tokenpath.ai →",
          href: TokenPath.PLATFORM_URL,
        },
      });
      this.updateCredits(0);
      return;
    }
    if (error.status === 429) {
      this.addMessage({
        kind: "error",
        role: "assistant",
        text: "TokenPath is rate-limiting requests — try again in a few seconds.",
      });
      return;
    }
    this.addMessage({
      kind: "error",
      role: "assistant",
      text: error.message || "TokenPath request failed.",
    });
  }

  private addMessage(message: Omit<PanelMessage, "id">) {
    const next: PanelMessage = {
      ...message,
      id: `message-${++this.messageSequence}`,
    };
    this.update({ messages: [...this.snapshot.messages, next] });
  }

  private async askLLM(
    context: string,
    messages: Array<{
      role: "user" | "assistant";
      content: string;
    }>,
    { maxOutputTokens = null }: { maxOutputTokens?: number | null } = {}
  ) {
    const lastUserIndex = messages
      .map((message) => message.role)
      .lastIndexOf("user");
    const question =
      lastUserIndex === -1
        ? "Summarize the selected text."
        : messages[lastUserIndex].content;
    const prior = messages
      .slice(0, lastUserIndex === -1 ? messages.length : lastUserIndex)
      .filter((message) => message.content && message.content.trim())
      .slice(-40)
      .map((message) => ({
        role: message.role,
        content: TldrPanelLogic.truncateCodePoints(message.content, 10_000),
      }));

    return TokenPath.answer({
      document: TldrPanelLogic.truncateCodePoints(
        context,
        TokenPath.MAX_DOCUMENT_CHARS
      ),
      question: TldrPanelLogic.truncateCodePoints(question, 10_000),
      messages: prior,
      maxOutputTokens,
    });
  }

  private isCurrentHighlight(source: HighlightSource, epoch: number) {
    return (
      epoch === this.highlightEpoch &&
      !this.invalidated &&
      source.contextVersion === this.contextVersion &&
      source.captureId === this.captureId
    );
  }

  private clearHighlightTarget(target: HighlightSource | null) {
    if (!target || target.tabId == null) return Promise.resolve();
    return chrome.tabs
      .sendMessage(
        target.tabId,
        {
          type: "clear-highlight",
          captureId: target.captureId || null,
        },
        { frameId: target.frameId }
      )
      .then(() => undefined)
      .catch(() => undefined);
  }

  private async clearActiveHighlight(fallback: HighlightSource | null = null) {
    const target = this.highlightedTarget || fallback;
    this.highlightedTarget = null;
    await this.clearHighlightTarget(target);
  }

  private cancelHighlightAndClear() {
    this.highlightEpoch++;
    void this.clearActiveHighlight();
  }

  private watchTab() {
    chrome.tabs.onUpdated.addListener((id, changeInfo) => {
      if (id !== this.tabId || !changeInfo.url) return;
      this.invalidate(
        "The page navigated. The captured selection no longer maps to the live page — re-select text and choose TLDR again."
      );
    });
    chrome.tabs.onRemoved.addListener((id) => {
      if (id === this.tabId) this.invalidate("The tab was closed.");
    });
  }

  private invalidate(reason: string) {
    this.invalidated = true;
    this.cancelHighlightAndClear();
    this.update({ notice: reason });
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
