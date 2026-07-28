import {
  ChevronRightIcon,
  CircleAlertIcon,
  EraserIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  MonitorIcon,
  MousePointer2Icon,
  MoonIcon,
  SunIcon,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { ComponentProps } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  type PanelController,
  type PanelMessage,
  type PanelSnapshot,
  type SummaryLength,
} from "@/controller";
import {
  answerRangeFromSelection,
  createAnswerDomMapper,
  type AnswerDomMapper,
} from "@/answer-selection";
import { cn } from "@/lib/utils";

const TOKENPATH_DEVELOPER_URL =
  "https://tokenpath.ai/?utm_source=tldr-extension&utm_medium=product&utm_campaign=developer_cta";
const AVAILABLE_ANSWER_HIGHLIGHT = "tokenpath-answer-attributable";
const HOVERED_ANSWER_HIGHLIGHT = "tokenpath-answer-hover";
const availableAnswerRanges = new Map<string, Range[]>();
const hoveredAnswerRanges = new Map<string, Range[]>();

function syncAnswerHighlight(
  name: string,
  groups: Map<string, Range[]>
) {
  if (!CSS.highlights || typeof Highlight !== "function") return;
  const ranges = [...groups.values()].flat();
  if (ranges.length === 0) {
    CSS.highlights.delete(name);
    return;
  }
  CSS.highlights.set(name, new Highlight(...ranges));
}

function setAnswerHighlightRanges(
  name: string,
  groups: Map<string, Range[]>,
  messageId: string,
  ranges: Range[]
) {
  if (ranges.length > 0) groups.set(messageId, ranges);
  else groups.delete(messageId);
  syncAnswerHighlight(name, groups);
}

function samePhrase(
  first: TldrAnswerAttributionPhrase | null,
  second: TldrAnswerAttributionPhrase | null
) {
  return first?.start === second?.start && first?.end === second?.end;
}

function TokenPathWordmark() {
  return (
    <span aria-hidden="true" className="tokenpath-wordmark">
      <span className="tokenpath-wordmark-token">token</span>
      <span className="tokenpath-wordmark-path">path</span>
    </span>
  );
}

const ANSWER_COMPONENTS = {
  img: () => null,
  a: ({
    children,
    className,
    href,
    node: _node,
    title,
  }: ComponentProps<"a"> & { node?: unknown }) => (
    <span className="answer-link">
      <span
        className={className}
        data-streamdown="link"
        onClick={() => {
          if (!href || !window.getSelection()?.isCollapsed) return;
          window.open(href, "_blank", "noopener,noreferrer");
        }}
        title={title || href}
      >
        {children}
      </span>
      {href && (
        <a
          aria-label={`Open link: ${href}`}
          className="answer-link-open"
          draggable={false}
          href={href}
          rel="noreferrer"
          target="_blank"
          title={`Open ${href}`}
        >
          <ExternalLinkIcon aria-hidden="true" />
        </a>
      )}
    </span>
  ),
};

function AnswerResponse({
  message,
  controller,
  animateClickHint,
}: {
  message: PanelMessage;
  controller: PanelController;
  animateClickHint: boolean;
}) {
  const answerRoot = useRef<HTMLDivElement>(null);
  const mapper = useRef<AnswerDomMapper | null>(null);
  const phraseRanges = useRef(new Map<string, Range>());
  const [hoveredPhrase, setHoveredPhrase] =
    useState<TldrAnswerAttributionPhrase | null>(null);
  const phrases = useMemo(() => {
    const attribution = message.attribution;
    if (
      message.answerStatus !== "ready" ||
      attribution?.status !== "ready" ||
      !attribution.heatmap ||
      !message.text
    ) {
      return [];
    }
    return TldrPanelLogic.buildAnswerAttributionPhrases(
      attribution.heatmap,
      message.text
    );
  }, [message.answerStatus, message.attribution, message.text]);

  useEffect(() => {
    const root = answerRoot.current;
    if (!root || phrases.length === 0) {
      mapper.current = null;
      phraseRanges.current = new Map();
      setHoveredPhrase(null);
      setAnswerHighlightRanges(
        AVAILABLE_ANSWER_HIGHLIGHT,
        availableAnswerRanges,
        message.id,
        []
      );
      setAnswerHighlightRanges(
        HOVERED_ANSWER_HIGHLIGHT,
        hoveredAnswerRanges,
        message.id,
        []
      );
      return;
    }

    const nextMapper = createAnswerDomMapper(root, message.text);
    mapper.current = nextMapper;
    const ranges = new Map<string, Range>();
    for (const phrase of phrases) {
      const range = nextMapper?.rangeForSpan(phrase);
      if (range) ranges.set(`${phrase.start}:${phrase.end}`, range);
    }
    phraseRanges.current = ranges;
    setAnswerHighlightRanges(
      AVAILABLE_ANSWER_HIGHLIGHT,
      availableAnswerRanges,
      message.id,
      [...ranges.values()]
    );

    return () => {
      mapper.current = null;
      phraseRanges.current = new Map();
      availableAnswerRanges.delete(message.id);
      hoveredAnswerRanges.delete(message.id);
      syncAnswerHighlight(
        AVAILABLE_ANSWER_HIGHLIGHT,
        availableAnswerRanges
      );
      syncAnswerHighlight(HOVERED_ANSWER_HIGHLIGHT, hoveredAnswerRanges);
    };
  }, [message.id, message.text, phrases]);

  useEffect(() => {
    const range = hoveredPhrase
      ? phraseRanges.current.get(
          `${hoveredPhrase.start}:${hoveredPhrase.end}`
        )
      : null;
    setAnswerHighlightRanges(
      HOVERED_ANSWER_HIGHLIGHT,
      hoveredAnswerRanges,
      message.id,
      range ? [range] : []
    );
  }, [hoveredPhrase, message.id]);

  const locateSelection = useCallback(() => {
    if (
      !answerRoot.current ||
      message.answerStatus === "streaming" ||
      !message.text
    ) {
      return;
    }
    const range = answerRangeFromSelection(answerRoot.current, message.text);
    if (!range) return;
    void controller.onAnswerSelection(message.id, range.start, range.end);
  }, [controller, message.answerStatus, message.id, message.text]);
  const phraseAtPoint = useCallback(
    (clientX: number, clientY: number) => {
      const offset = mapper.current?.offsetAtPoint(clientX, clientY);
      if (offset == null) return null;
      return (
        phrases.find(
          (phrase) => offset >= phrase.start && offset < phrase.end
        ) || null
      );
    },
    [phrases]
  );
  const updateHoveredPhrase = useCallback(
    (next: TldrAnswerAttributionPhrase | null) => {
      setHoveredPhrase((current) =>
        samePhrase(current, next) ? current : next
      );
    },
    []
  );
  const interactionTitle =
    message.answerStatus === "ready"
      ? "Click an underlined phrase to reveal its source"
      : undefined;

  return (
    <div
      className={cn(
        "selectable-answer",
        animateClickHint && phrases.length > 0 && "is-click-intro",
        hoveredPhrase && "has-attribution-hover"
      )}
      data-answer-status={message.answerStatus}
      data-has-click-targets={phrases.length > 0}
      title={interactionTitle}
    >
      <div
        data-answer-content=""
        onClick={(event) => {
          if (
            message.answerStatus !== "ready" ||
            !window.getSelection()?.isCollapsed ||
            (event.target instanceof Element &&
              event.target.closest(".answer-link"))
          ) {
            return;
          }
          const phrase = phraseAtPoint(event.clientX, event.clientY);
          if (!phrase) return;
          void controller.onAnswerSelection(
            message.id,
            phrase.start,
            phrase.end
          );
        }}
        onKeyUp={locateSelection}
        onPointerLeave={() => updateHoveredPhrase(null)}
        onPointerMove={(event) => {
          if (
            message.answerStatus !== "ready" ||
            !window.getSelection()?.isCollapsed ||
            (event.target instanceof Element &&
              event.target.closest(".answer-link"))
          ) {
            updateHoveredPhrase(null);
            return;
          }
          updateHoveredPhrase(phraseAtPoint(event.clientX, event.clientY));
        }}
        onPointerUp={(event) => {
          if (event.button !== 0) return;
          requestAnimationFrame(locateSelection);
        }}
        ref={answerRoot}
      >
        <MessageResponse
          components={ANSWER_COMPONENTS as never}
          mode={
            message.answerStatus === "streaming" ? "streaming" : "static"
          }
          parseIncompleteMarkdown={message.answerStatus === "streaming"}
          skipHtml
          urlTransform={(url, key) => {
            if (key === "src") return null;
            return /^(https?:|mailto:)/i.test(url) ? url : null;
          }}
        >
          {message.text}
        </MessageResponse>
      </div>
      {message.answerStatus === "attributing" && (
        <div className="answer-attribution-status" role="status">
          <Spinner className="size-3" />
          <span>Mapping this answer to the source…</span>
        </div>
      )}
      {message.answerStatus === "ready" && phrases.length > 0 && (
        <div
          aria-label="Click an underlined phrase in this answer to reveal its source"
          className={cn(
            "answer-attribution-guide",
            animateClickHint && "is-animated"
          )}
        >
          <MousePointer2Icon aria-hidden="true" />
          <span>
            Click an underlined phrase
            <span aria-hidden="true" className="answer-attribution-detail">
              {" "}
              to reveal its source
            </span>
          </span>
        </div>
      )}
      {message.answerStatus === "unavailable" && (
        <div
          className="answer-attribution-status answer-attribution-error"
          title={message.attribution?.error}
        >
          <CircleAlertIcon className="size-3" />
          <span>Source map unavailable</span>
        </div>
      )}
    </div>
  );
}

function ChatMessage({
  message,
  controller,
  animateClickHint,
}: {
  message: PanelMessage;
  controller: PanelController;
  animateClickHint: boolean;
}) {
  const isNote = message.kind === "note";
  const isError = message.kind === "error";

  return (
    <Message
      className={cn(isNote && "max-w-full", isError && "message-error")}
      from={message.role}
    >
      <MessageContent
        className={cn(
          isNote &&
            "w-full rounded-lg border border-dashed border-border bg-muted/35 px-3 py-2 text-xs text-muted-foreground",
          isError &&
            "w-full rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2.5 text-destructive"
        )}
      >
        {message.kind === "answer" ? (
          <AnswerResponse
            animateClickHint={animateClickHint}
            controller={controller}
            message={message}
          />
        ) : (
          <div className="whitespace-pre-wrap break-words">
            {message.text}
            {message.link && (
              <a
                className="ml-1 font-medium underline underline-offset-2"
                href={message.link.href}
                rel="noreferrer"
                target="_blank"
              >
                {message.link.label}
              </a>
            )}
          </div>
        )}
      </MessageContent>
    </Message>
  );
}

function ThinkingMessage() {
  return (
    <Message from="assistant">
      <MessageContent className="text-muted-foreground">
        <div className="flex items-center gap-2 text-xs" role="status">
          <Spinner className="size-3.5" />
          <span>Thinking…</span>
        </div>
      </MessageContent>
    </Message>
  );
}

function ThemeIcon({ snapshot }: { snapshot: PanelSnapshot }) {
  if (snapshot.themePreference === "system") {
    return <MonitorIcon className="size-3.5" />;
  }
  return snapshot.resolvedTheme === "dark" ? (
    <MoonIcon className="size-3.5" />
  ) : (
    <SunIcon className="size-3.5" />
  );
}

function nextThemeLabel(snapshot: PanelSnapshot) {
  const next = {
    system: "light",
    light: "dark",
    dark: "system",
  }[snapshot.themePreference];
  return `Theme: ${snapshot.themePreference}. Switch to ${next}.`;
}

export function App({ controller }: { controller: PanelController }) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot
  );
  const [input, setInput] = useState("");
  const [sourceExpanded, setSourceExpanded] = useState(false);
  const [tokenPathKey, setTokenPathKey] = useState("");
  const hasStreamingAnswer = snapshot.messages.some(
    (message) =>
      message.answerStatus === "streaming" && Boolean(message.text)
  );
  const sourceTextVisible = !snapshot.hasContext || sourceExpanded;

  useEffect(() => {
    setSourceExpanded(false);
  }, [snapshot.contextText, snapshot.hasContext]);

  const latestReadyAnswerId =
    [...snapshot.messages]
      .reverse()
      .find(
        (message) =>
          message.kind === "answer" && message.answerStatus === "ready"
      )?.id || null;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="panel-header flex h-12 shrink-0 items-center justify-between px-3.5">
        <div className="brand-lockup">
          <a
            aria-label="Visit TokenPath (opens in a new tab)"
            className="tokenpath-wordmark-link"
            href="https://tokenpath.ai"
            rel="noopener noreferrer"
            target="_blank"
          >
            <TokenPathWordmark />
          </a>
          <span aria-hidden="true" className="brand-divider">
            /
          </span>
          <span
            className="product-name"
            title="TokenPath — Chat with Attribution"
          >
            Chat
          </span>
        </div>
        <div className="flex items-center gap-1.5">
          <span
            className="token-badge"
            hidden={!snapshot.creditsText}
            id="credits"
            title="TokenPath tokens remaining"
          >
            {snapshot.creditsText}
          </span>
          <Button
            aria-label={nextThemeLabel(snapshot)}
            id="theme-toggle"
            onClick={controller.cycleTheme}
            size="icon-xs"
            title={nextThemeLabel(snapshot)}
            variant="ghost"
          >
            <ThemeIcon snapshot={snapshot} />
          </Button>
          <Button
            className="gap-1.5 px-2"
            id="clear-hl"
            onClick={controller.clearHighlights}
            size="sm"
            title="Clear source highlight"
            variant="outline"
          >
            <EraserIcon className="size-3.5" />
            <span className="hidden min-[390px]:inline">Clear</span>
          </Button>
        </div>
      </header>
      <div aria-hidden="true" className="token-rail" />

      <section
        className="auth-panel border-b border-border p-3"
        hidden={snapshot.connected}
        id="auth"
      >
        <div className="mb-2.5 flex items-start gap-2.5">
          <div className="auth-key-icon mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border">
            <KeyRoundIcon className="size-3.5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold">
              Connect TokenPath
            </div>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              One key generates the answer and maps it back to the source.
            </p>
          </div>
        </div>
        <form
          className="grid gap-2"
          id="auth-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const connected = await controller.connect(tokenPathKey);
            if (connected) {
              setTokenPathKey("");
            }
          }}
        >
          <div className="grid grid-cols-[5.25rem_minmax(0,1fr)] items-center gap-2">
            <label
              className="text-[11px] font-medium text-muted-foreground"
              htmlFor="tokenpath-key"
            >
              TokenPath
            </label>
            <Input
              aria-label="TokenPath API key"
              autoComplete="off"
              autoFocus={!snapshot.hasContext}
              className="min-w-0 font-mono text-xs"
              disabled={snapshot.authBusy}
              id="tokenpath-key"
              onChange={(event) =>
                setTokenPathKey(event.currentTarget.value)
              }
              placeholder={
                snapshot.tokenPathReady
                  ? "Saved — leave blank to keep"
                  : "tpk_live_…"
              }
              spellCheck={false}
              type="password"
              value={tokenPathKey}
            />
          </div>
          <Button
            disabled={
              snapshot.authBusy ||
              (!snapshot.tokenPathReady && !tokenPathKey.trim())
            }
            id="auth-connect"
            size="sm"
            type="submit"
          >
            {snapshot.authBusy ? <Spinner /> : "Connect"}
          </Button>
        </form>
        <div
          className="mt-2 text-xs text-destructive"
          hidden={!snapshot.authError}
          id="auth-error"
          role="alert"
        >
          {snapshot.authError}
        </div>
        <div className="mt-2.5 text-[11px] leading-4 text-muted-foreground">
          <div>
            TokenPath receives the website origin, captured page or PDF text,
            your questions, and generated answers.
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            <a
              className="brand-link font-medium"
              href="https://platform.tokenpath.ai"
              rel="noopener noreferrer"
              target="_blank"
            >
              Get a free API key ↗
            </a>
          </div>
        </div>
      </section>

      <section
        aria-label={snapshot.contextLabel}
        className={cn(
          "source-card shrink-0",
          snapshot.hasContext && !sourceExpanded && "is-collapsed",
          sourceExpanded && "is-expanded"
        )}
        id="context"
      >
        <div
          className={cn(
            "source-card-header flex items-center justify-between gap-2",
            sourceTextVisible && "mb-1.5"
          )}
        >
          {snapshot.hasContext ? (
            <button
              aria-label={
                sourceExpanded
                  ? `Hide ${snapshot.contextLabel.toLowerCase()}`
                  : `Show ${snapshot.contextLabel.toLowerCase()}`
              }
              aria-controls="context-text"
              aria-expanded={sourceExpanded}
              className="source-toggle"
              id="context-toggle"
              onClick={() => setSourceExpanded((expanded) => !expanded)}
              title={
                sourceExpanded
                  ? `Hide ${snapshot.contextLabel.toLowerCase()}`
                  : `Show ${snapshot.contextLabel.toLowerCase()}`
              }
              type="button"
            >
              <ChevronRightIcon aria-hidden="true" />
              <span className="source-label">{snapshot.contextLabel}</span>
            </button>
          ) : (
            <div className="source-label">{snapshot.contextLabel}</div>
          )}
          <label
            className="summary-length-control"
            title="Applies to the next TLDR; also updates one that is still waiting to start"
          >
            <span>Summary</span>
            <select
              aria-label="Automatic summary length"
              className="summary-length-select"
              id="summary-length"
              onChange={(event) =>
                controller.setSummaryLength(
                  event.currentTarget.value as SummaryLength
                )
              }
              value={snapshot.summaryLength}
            >
              <option value="low">Short</option>
              <option value="medium">Medium</option>
              <option value="high">Detailed</option>
            </select>
          </label>
        </div>
        <div
          className="context-text"
          hidden={!sourceTextVisible}
          id="context-text"
        >
          {snapshot.contextText}
        </div>
      </section>

      <div
        className="border-b border-destructive/20 bg-destructive/5 px-3.5 py-2 text-xs leading-5 text-destructive"
        hidden={!snapshot.notice}
        id="notice"
        role="alert"
      >
        {snapshot.notice}
      </div>

      <Conversation className="min-h-0" id="messages">
        <ConversationContent className="gap-5 px-3.5 py-4">
          {snapshot.messages.map((message) => (
            <ChatMessage
              animateClickHint={message.id === latestReadyAnswerId}
              controller={controller}
              key={message.id}
              message={message}
            />
          ))}
          {snapshot.busy && snapshot.hasContext && !hasStreamingAnswer && (
            <ThinkingMessage />
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="shrink-0 border-t border-border/80 bg-background px-3 pb-2.5 pt-3">
        <PromptInput
          id="composer"
          onSubmit={({ text }) => {
            const sent = controller.submit(text);
            if (sent) setInput("");
          }}
        >
          <PromptInputTextarea
            autoComplete="off"
            disabled={!snapshot.hasContext || snapshot.busy}
            id="input"
            onChange={(event) => setInput(event.currentTarget.value)}
            placeholder={
              snapshot.hasContext
                ? snapshot.contextLabel === "Entire PDF"
                  ? "Ask about the PDF…"
                  : snapshot.contextLabel === "Entire page"
                    ? "Ask about the page…"
                    : "Ask about the selection…"
                : snapshot.contextText === "Reading the full PDF…"
                  ? "Reading PDF…"
                  : "Select text, or right-click for the full page or PDF"
            }
            value={input}
          />
          <PromptInputFooter className="justify-end">
            <PromptInputSubmit
              disabled={
                !snapshot.hasContext ||
                !snapshot.connected ||
                snapshot.busy ||
                !input.trim()
              }
              id="send"
              status={snapshot.busy ? "submitted" : "ready"}
            />
          </PromptInputFooter>
        </PromptInput>

        <footer className="product-footer">
          <a
            aria-label="Build with TokenPath — add source attribution to your app (opens in a new tab)"
            className="developer-cta"
            href={TOKENPATH_DEVELOPER_URL}
            id="tokenpath-cta"
            rel="noopener noreferrer"
            target="_blank"
            title="Add exact source attribution to your AI app with TokenPath"
          >
            <span>Build with TokenPath</span>
            <ExternalLinkIcon aria-hidden="true" />
          </a>
          <button
            className="disconnect-button"
            hidden={!snapshot.tokenPathReady}
            id="disconnect"
            onClick={() => void controller.disconnect()}
            type="button"
          >
            Disconnect
          </button>
        </footer>
      </div>

      <div
        aria-live="polite"
        className="toast"
        hidden={!snapshot.toast}
        id="toast"
        role="status"
      >
        {snapshot.toast}
      </div>
    </div>
  );
}
