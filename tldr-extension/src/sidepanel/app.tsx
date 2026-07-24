import {
  EraserIcon,
  KeyRoundIcon,
  MonitorIcon,
  MoonIcon,
  SparklesIcon,
  SunIcon,
} from "lucide-react";
import type { HTMLAttributes, KeyboardEvent, MouseEvent, ReactNode } from "react";
import { useMemo, useState, useSyncExternalStore } from "react";
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
  type HighlightSource,
  type PanelController,
  type PanelMessage,
  type PanelSnapshot,
} from "@/controller";
import { cn } from "@/lib/utils";
import {
  normalizeAttributions,
  supportsAttributedMarkdown,
} from "@/markdown-attribution";

type AttributionElementProps = HTMLAttributes<HTMLElement> & {
  source_start?: string | number;
  source_end?: string | number;
  confidence?: string | number;
  node?: unknown;
};

function AttributionSpan({
  children,
  className,
  confidence,
  controller,
  source,
  sourceEnd,
  sourceStart,
  ...props
}: {
  children: ReactNode;
  className?: string;
  confidence?: number;
  controller: PanelController;
  source?: HighlightSource;
  sourceEnd: number;
  sourceStart: number;
} & Omit<HTMLAttributes<HTMLSpanElement>, "children">) {
  const hasConfidence = Number.isFinite(confidence);
  const isLowConfidence =
    hasConfidence && Number(confidence) < 0.35;
  const title = hasConfidence
    ? `${Math.round(Number(confidence) * 100)}% match — click to find in the page`
    : "Click to find this in the page";
  const activate = () => {
    if (!source) return;
    void controller.onAttributionClick(sourceStart, sourceEnd, source);
  };
  const onClick = (event: MouseEvent<HTMLSpanElement>) => {
    event.preventDefault();
    event.stopPropagation();
    activate();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLSpanElement>) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    activate();
  };

  return (
    <span
      {...props}
      className={cn("attrib", isLowConfidence && "attrib-low", className)}
      onClick={onClick}
      onKeyDown={onKeyDown}
      role="button"
      tabIndex={0}
      title={title}
    >
      {children}
    </span>
  );
}

function PlainAttributedResponse({
  attributions,
  controller,
  message,
}: {
  attributions: TldrAttribution[];
  controller: PanelController;
  message: PanelMessage;
}) {
  const parts: ReactNode[] = [];
  let cursor = 0;
  for (const [index, attribution] of attributions.entries()) {
    parts.push(message.text.slice(cursor, attribution.answerStart));
    parts.push(
      <AttributionSpan
        confidence={attribution.confidence}
        controller={controller}
        key={`${attribution.answerStart}-${attribution.answerEnd}-${index}`}
        source={message.source}
        sourceEnd={attribution.sourceEnd}
        sourceStart={attribution.sourceStart}
      >
        {message.text.slice(
          attribution.answerStart,
          attribution.answerEnd
        )}
      </AttributionSpan>
    );
    cursor = attribution.answerEnd;
  }
  parts.push(message.text.slice(cursor));

  return (
    <div
      className="whitespace-pre-wrap break-words text-sm leading-6"
      data-attribution-renderer="plain"
    >
      {parts}
    </div>
  );
}

function AttributedResponse({
  message,
  controller,
}: {
  message: PanelMessage;
  controller: PanelController;
}) {
  const source = message.source;
  const rendering = useMemo(
    () => {
      const attributions = normalizeAttributions(
        message.text,
        message.attributions || []
      );
      const markdown = supportsAttributedMarkdown(message.text, attributions);
      return {
        attributions,
        markdown,
        content: markdown
          ? TldrPanelLogic.annotateMarkdownAttributions(
              message.text,
              attributions
            )
          : message.text,
      };
    },
    [message.attributions, message.text]
  );
  const components = useMemo(() => {
    const Attribution = ({
      source_start: sourceStartValue,
      source_end: sourceEndValue,
      confidence: confidenceValue,
      node: _node,
      children,
      className,
      ...props
    }: AttributionElementProps) => {
      const sourceStart = Number(sourceStartValue);
      const sourceEnd = Number(sourceEndValue);
      const confidence = Number(confidenceValue);

      return (
        <AttributionSpan
          className={className}
          confidence={confidence}
          controller={controller}
          source={source}
          sourceEnd={sourceEnd}
          sourceStart={sourceStart}
          {...props}
        >
          {children}
        </AttributionSpan>
      );
    };

    const BlockedImage = () => null;

    return {
      img: BlockedImage,
      "tldr-attribution": Attribution,
    };
  }, [controller, source]);

  if (!rendering.markdown) {
    return (
      <PlainAttributedResponse
        attributions={rendering.attributions}
        controller={controller}
        message={message}
      />
    );
  }

  return (
    <MessageResponse
      allowedTags={{
        "tldr-attribution": ["source_start", "source_end", "confidence"],
      }}
      components={components as never}
      literalTagContent={["tldr-attribution"]}
      mode="static"
      parseIncompleteMarkdown={false}
      urlTransform={(url, key) => {
        if (key === "src") return null;
        return /^(https?:|mailto:)/i.test(url) ? url : null;
      }}
    >
      {rendering.content}
    </MessageResponse>
  );
}

function ChatMessage({
  message,
  controller,
}: {
  message: PanelMessage;
  controller: PanelController;
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
          <AttributedResponse controller={controller} message={message} />
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
  const [authKey, setAuthKey] = useState("");

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border/80 px-3.5">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex size-6 items-center justify-center rounded-md bg-foreground text-background shadow-xs">
            <SparklesIcon className="size-3.5" />
          </div>
          <span className="text-sm font-semibold tracking-[-0.015em]">TLDR</span>
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
            title="Clear page highlight"
            variant="outline"
          >
            <EraserIcon className="size-3.5" />
            <span className="hidden min-[390px]:inline">Clear</span>
          </Button>
        </div>
      </header>

      <section
        className="border-b border-border bg-muted/35 p-3"
        hidden={snapshot.connected}
        id="auth"
      >
        <div className="mb-2.5 flex items-start gap-2.5">
          <div className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-lg border border-border bg-background text-muted-foreground">
            <KeyRoundIcon className="size-3.5" />
          </div>
          <div className="min-w-0">
            <div className="text-sm font-semibold">Connect TokenPath</div>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              Paste an API key to generate grounded, attributed answers.
            </p>
          </div>
        </div>
        <form
          className="flex gap-2"
          id="auth-form"
          onSubmit={async (event) => {
            event.preventDefault();
            const connected = await controller.connect(authKey);
            if (connected) setAuthKey("");
          }}
        >
          <Input
            aria-label="TokenPath API key"
            autoComplete="off"
            autoFocus={!snapshot.hasContext}
            className="min-w-0 flex-1 font-mono text-xs"
            disabled={snapshot.authBusy}
            id="auth-key"
            onChange={(event) => setAuthKey(event.currentTarget.value)}
            placeholder="tpk_live_…"
            spellCheck={false}
            type="password"
            value={authKey}
          />
          <Button
            disabled={!authKey.trim() || snapshot.authBusy}
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
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-1.5 text-[11px] leading-4 text-muted-foreground">
          <span>Only the selection and your questions are sent.</span>
          <a
            className="font-medium text-primary hover:underline"
            href="https://platform.tokenpath.ai"
            rel="noreferrer"
            target="_blank"
          >
            Get an API key →
          </a>
        </div>
      </section>

      <section
        aria-label="Selected page text; focus to expand"
        className="source-card shrink-0"
        id="context"
        tabIndex={snapshot.hasContext ? 0 : -1}
      >
        <div className="mb-1.5 flex items-center justify-between gap-2">
          <div className="source-label">Selected from page</div>
          {snapshot.hasContext && (
            <span className="text-[10px] text-muted-foreground">Source</span>
          )}
        </div>
        <div className="context-text" id="context-text">
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
              controller={controller}
              key={message.id}
              message={message}
            />
          ))}
          {snapshot.busy && <ThinkingMessage />}
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
                ? "Ask about the selection…"
                : "Select text on a page to begin"
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

        <footer className="mt-2 flex min-h-4 items-center justify-center gap-1.5 text-[10.5px] text-muted-foreground">
          <span>
            Powered by{" "}
            <a
              className="font-medium text-primary hover:underline"
              href="https://tokenpath.ai"
              rel="noreferrer"
              target="_blank"
            >
              TokenPath
            </a>
          </span>
          <span aria-hidden="true">·</span>
          <span>token-level attribution</span>
          <button
            className="ml-1 underline underline-offset-2 hover:text-foreground"
            hidden={!snapshot.connected}
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
