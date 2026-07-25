import {
  CircleAlertIcon,
  EraserIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  MonitorIcon,
  MoonIcon,
  SparklesIcon,
  SunIcon,
  TextSelectIcon,
} from "lucide-react";
import {
  useCallback,
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
} from "@/controller";
import { answerRangeFromSelection } from "@/answer-selection";
import { cn } from "@/lib/utils";

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
}: {
  message: PanelMessage;
  controller: PanelController;
}) {
  const answerRoot = useRef<HTMLDivElement>(null);
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
  const selectionTitle =
    message.answerStatus === "ready"
      ? "Select any text in this answer to find its source"
      : undefined;

  return (
    <div
      className="selectable-answer"
      data-answer-status={message.answerStatus}
      title={selectionTitle}
    >
      <div
        data-answer-content=""
        onKeyUp={locateSelection}
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
          <span>Mapping this answer to the page…</span>
        </div>
      )}
      {message.answerStatus === "ready" && (
        <div className="answer-attribution-status">
          <TextSelectIcon className="size-3" />
          <span>Select any text to find its source</span>
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
          <AnswerResponse controller={controller} message={message} />
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
  const [tokenPathKey, setTokenPathKey] = useState("");
  const hasStreamingAnswer = snapshot.messages.some(
    (message) =>
      message.answerStatus === "streaming" && Boolean(message.text)
  );

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
            <div className="text-sm font-semibold">
              Connect TokenPath
            </div>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              One key generates the answer and maps it back to the page.
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
            The selection, questions, and generated answer are sent to
            TokenPath.
          </div>
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            <a
              className="font-medium text-primary hover:underline"
              href="https://platform.tokenpath.ai"
              rel="noreferrer"
              target="_blank"
            >
              TokenPath key →
            </a>
          </div>
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
          {snapshot.busy && !hasStreamingAnswer && <ThinkingMessage />}
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
