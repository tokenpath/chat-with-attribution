import { CircleAlertIcon, InfoIcon, ListCollapseIcon, XIcon } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Conversation,
  ConversationContent,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import { AuthPanel } from "@/components/panel/auth-panel";
import { ChatMessage, ThinkingMessage } from "@/components/panel/chat-message";
import { Composer } from "@/components/panel/composer";
import { PanelHeader } from "@/components/panel/panel-header";
import { SourceCard } from "@/components/panel/source-card";
import type { AnswerStatus, PanelController, PanelMessage } from "@/controller";
import { useAnswerHighlights } from "@/hooks/use-answer-highlights";
import { summaryFallbackPrompt } from "@/lib/source-copy";
import { findLast } from "@/lib/utils";

// The controller emits this note through its own copy; the view only needs to
// know that one is present so it never shows "Summarize" beside it.
const CONCISE_NOTE_PREFIX = "Already concise";

function isAnswer(message: PanelMessage) {
  return message.kind === "answer";
}

/**
 * Answers that finished generating during this panel session. A chat restored
 * from the cache arrives already "ready", and replaying the click hint for it
 * would teach nothing.
 */
function useSessionCompletedAnswers(messages: PanelMessage[]) {
  const lastSeenStatus = useRef(new Map<string, AnswerStatus | undefined>());
  const completed = useRef(new Set<string>());

  const present = new Set<string>();
  for (const message of messages) {
    if (!isAnswer(message)) continue;
    present.add(message.id);
    const seen = lastSeenStatus.current.has(message.id);
    const previous = lastSeenStatus.current.get(message.id);
    if (seen && previous !== "ready" && message.answerStatus === "ready") {
      completed.current.add(message.id);
    }
    lastSeenStatus.current.set(message.id, message.answerStatus);
  }
  for (const id of lastSeenStatus.current.keys()) {
    if (!present.has(id)) {
      lastSeenStatus.current.delete(id);
      completed.current.delete(id);
    }
  }

  return completed.current;
}

export function App({
  controller,
  initialized,
}: {
  controller: PanelController;
  initialized?: Promise<unknown>;
}) {
  const snapshot = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot
  );
  const highlights = useAnswerHighlights();
  const keyInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [authResolved, setAuthResolved] = useState(!initialized);
  const [dismissedNotice, setDismissedNotice] = useState<string | null>(null);
  // The sequence number forces a fresh DOM node per announcement; an
  // unchanged text node would be silently skipped by screen readers.
  const [answerAnnouncement, setAnswerAnnouncement] = useState({
    text: "",
    seq: 0,
  });

  const completedThisSession = useSessionCompletedAnswers(snapshot.messages);
  const latestAnswer = findLast(snapshot.messages, isAnswer);
  const latestReadyAnswerId =
    latestAnswer?.answerStatus === "ready" ? latestAnswer.id : null;
  const hasStreamingAnswer = snapshot.messages.some(
    (message) => message.answerStatus === "streaming" && Boolean(message.text)
  );
  const chatIsEmpty = snapshot.messages.every(
    (message) => message.kind === "note"
  );
  const hasConciseNote = snapshot.messages.some(
    (message) =>
      message.kind === "note" && message.text.startsWith(CONCISE_NOTE_PREFIX)
  );
  const notice =
    snapshot.notice && snapshot.notice !== dismissedNotice
      ? snapshot.notice
      : null;

  // Auth resolves asynchronously. Focusing the key field before then would
  // steal focus from every already-connected user, so wait for the answer.
  useEffect(() => {
    if (!initialized) return;
    let active = true;
    const resolve = () => {
      if (active) setAuthResolved(true);
    };
    void Promise.resolve(initialized).then(resolve, resolve);
    return () => {
      active = false;
    };
  }, [initialized]);

  const placedInitialFocus = useRef(false);
  useEffect(() => {
    if (!authResolved || placedInitialFocus.current) return;
    placedInitialFocus.current = true;
    if (snapshot.connected) textareaRef.current?.focus();
    else keyInputRef.current?.focus();
  }, [authResolved, snapshot.connected]);

  // A capture landing without a generated turn (the "Ask a question" action)
  // leaves the user one keystroke away from their question.
  const hadContext = useRef(snapshot.hasContext);
  useEffect(() => {
    const previous = hadContext.current;
    hadContext.current = snapshot.hasContext;
    if (previous || !snapshot.hasContext || !snapshot.connected) return;
    textareaRef.current?.focus();
  }, [snapshot.connected, snapshot.hasContext]);

  // A finished or stopped turn hands the composer back rather than leaving
  // focus on a button that just changed meaning.
  const wasBusy = useRef(snapshot.busy);
  useEffect(() => {
    const previous = wasBusy.current;
    wasBusy.current = snapshot.busy;
    if (!previous || snapshot.busy) return;
    const active = document.activeElement;
    if (active && active !== document.body && active.id !== "send") return;
    textareaRef.current?.focus();
  }, [snapshot.busy]);

  const previousAnswerStatus = useRef<{
    id: string;
    status: AnswerStatus | undefined;
  } | null>(null);
  useEffect(() => {
    const current = latestAnswer
      ? { id: latestAnswer.id, status: latestAnswer.answerStatus }
      : null;
    const previous = previousAnswerStatus.current;
    previousAnswerStatus.current = current;
    // Only transitions of the same answer count: Stop before the first token
    // removes the empty bubble, and the fallback to the previous ready answer
    // must not announce a completion that never happened.
    if (!current || !previous || previous.id !== current.id) return;
    const announce = (text: string) =>
      setAnswerAnnouncement((prior) => ({ text, seq: prior.seq + 1 }));
    if (previous.status === "streaming" && current.status !== "streaming") {
      announce(latestAnswer?.incomplete ? "Answer stopped." : "Answer complete.");
    } else if (previous.status === "attributing" && current.status === "ready") {
      announce("Sources ready for this answer.");
    }
  }, [latestAnswer]);

  // A dismissed notice stays dismissed only for its own lifetime; once the
  // controller clears it, the next occurrence must be visible again.
  useEffect(() => {
    if (!snapshot.notice) setDismissedNotice(null);
  }, [snapshot.notice]);

  // Connecting hides the auth section under the just-clicked button, which
  // would otherwise drop focus to <body>.
  const wasConnected = useRef(snapshot.connected);
  useEffect(() => {
    const previous = wasConnected.current;
    wasConnected.current = snapshot.connected;
    if (previous || !snapshot.connected || !authResolved) return;
    textareaRef.current?.focus();
  }, [authResolved, snapshot.connected]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <PanelHeader controller={controller} snapshot={snapshot} />
      <div aria-hidden="true" className="token-rail" />

      <AuthPanel
        controller={controller}
        keyInputRef={keyInputRef}
        snapshot={snapshot}
      />

      <SourceCard snapshot={snapshot} />

      <div className="notice-region" role="alert">
        <div
          className="context-error"
          hidden={!snapshot.contextError}
          id="context-error"
        >
          <CircleAlertIcon aria-hidden="true" />
          <span>{snapshot.contextError}</span>
        </div>
      </div>

      <div aria-live="polite" className="notice-region" role="status">
        <div className="panel-notice" hidden={!notice} id="notice">
          <InfoIcon aria-hidden="true" />
          <span>{notice}</span>
          <button
            aria-label="Dismiss this note"
            className="panel-notice-dismiss"
            onClick={() => setDismissedNotice(snapshot.notice)}
            title="Dismiss this note"
            type="button"
          >
            <XIcon aria-hidden="true" />
          </button>
        </div>
      </div>

      <Conversation aria-label="Conversation" className="min-h-0" id="messages">
        <ConversationContent className="gap-5 px-3.5 py-4">
          {snapshot.messages.map((message) => (
            <ChatMessage
              animateClickHint={
                message.id === latestReadyAnswerId &&
                completedThisSession.has(message.id)
              }
              controller={controller}
              highlights={highlights}
              key={message.id}
              message={message}
            />
          ))}
          {chatIsEmpty && !snapshot.busy && !hasConciseNote && (
            <div className="chat-starter">
              <p>What would you like to know?</p>
              <button
                className="starter-action"
                disabled={!snapshot.connected}
                id="summarize-starter"
                onClick={() => {
                  if (snapshot.hasContext && controller.runSummary()) return;
                  controller.submit(summaryFallbackPrompt(snapshot));
                }}
                type="button"
              >
                <ListCollapseIcon aria-hidden="true" />
                <span>Summarize</span>
              </button>
            </div>
          )}
          {snapshot.busy && !hasStreamingAnswer && <ThinkingMessage />}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <Composer
        controller={controller}
        snapshot={snapshot}
        textareaRef={textareaRef}
      />

      {/*
        Always-mounted announcement channels. The auth error has to live here
        because its own panel is hidden while connected, and a live region is
        only announced when it was already present and visible.
      */}
      <div aria-live="assertive" className="sr-only">
        {snapshot.authError || ""}
      </div>
      <div aria-live="polite" className="sr-only">
        <span key={answerAnnouncement.seq}>{answerAnnouncement.text}</span>
      </div>
    </div>
  );
}
