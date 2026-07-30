import {
  ExternalLinkIcon,
  Settings2Icon,
  SquareIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type RefObject } from "react";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import { SummaryLengthControl } from "@/components/panel/summary-length-control";
import { Button } from "@/components/ui/button";
import {
  type PanelController,
  type PanelSnapshot,
  SUMMARY_PROMPT_MAX_CHARS,
} from "@/controller";
import { composerPlaceholder } from "@/lib/source-copy";

const TOKENPATH_DEVELOPER_URL =
  "https://tokenpath.ai/?utm_source=tldr-extension&utm_medium=product&utm_campaign=developer_cta";

export function Composer({
  controller,
  snapshot,
  textareaRef,
}: {
  controller: PanelController;
  snapshot: PanelSnapshot;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const [input, setInput] = useState("");
  const [summaryPromptOpen, setSummaryPromptOpen] = useState(false);
  const [summaryPromptDraft, setSummaryPromptDraft] = useState(
    snapshot.summaryPrompt
  );
  const summaryPromptMenu = useRef<HTMLDivElement>(null);
  // Reading a page or PDF has nothing to ask about yet. A running turn does:
  // the composer stays usable so the next question can be drafted while the
  // answer streams, and only its submission is blocked.
  const isReading = snapshot.contextStatus === "reading";
  const canStop = snapshot.busy && !isReading;

  useEffect(() => {
    if (!summaryPromptOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        !summaryPromptMenu.current?.contains(event.target)
      ) {
        setSummaryPromptOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSummaryPromptOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [summaryPromptOpen]);

  return (
    <div className="composer-dock shrink-0 border-t border-border/80 bg-background px-3 pb-2.5 pt-3">
      <PromptInput
        id="composer"
        onSubmit={({ text }) => {
          if (snapshot.busy) return;
          const sent = controller.submit(text);
          if (sent) setInput("");
        }}
      >
        <PromptInputTextarea
          autoComplete="off"
          disabled={isReading}
          id="input"
          onChange={(event) => setInput(event.currentTarget.value)}
          placeholder={composerPlaceholder(snapshot)}
          ref={textareaRef}
          value={input}
        />
        <PromptInputFooter className="justify-between">
          <SummaryLengthControl
            disabled={snapshot.busy}
            onChange={controller.setSummaryLength}
            value={snapshot.summaryLength}
          />
          <PromptInputSubmit
            aria-label={canStop ? "Stop generating" : "Send message"}
            disabled={
              canStop
                ? false
                : !snapshot.connected || snapshot.busy || !input.trim()
            }
            id="send"
            onClick={
              canStop
                ? (event) => {
                    event.preventDefault();
                    controller.cancelTurn();
                  }
                : undefined
            }
            status={snapshot.busy && !canStop ? "submitted" : "ready"}
            title={canStop ? "Stop generating" : "Send message"}
          >
            {canStop ? (
              <SquareIcon className="size-3.5 fill-current" />
            ) : undefined}
          </PromptInputSubmit>
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
        <div className="product-footer-actions">
          <div className="summary-prompt-menu" ref={summaryPromptMenu}>
            <Button
              aria-expanded={summaryPromptOpen}
              aria-haspopup="dialog"
              aria-label={
                snapshot.summaryPromptCustomized
                  ? "Summary prompt settings — custom prompt active"
                  : "Summary prompt settings"
              }
              className="summary-prompt-trigger"
              data-custom={snapshot.summaryPromptCustomized}
              id="summary-prompt-settings"
              onClick={() => {
                setSummaryPromptDraft(snapshot.summaryPrompt);
                setSummaryPromptOpen((open) => !open);
              }}
              title="Summary prompt"
              size="icon-xs"
              variant="ghost"
            >
              <Settings2Icon aria-hidden="true" />
              <span
                aria-hidden="true"
                className="summary-prompt-custom-dot"
              />
            </Button>

            {summaryPromptOpen && (
              <form
                aria-label="Summary prompt settings"
                className="summary-prompt-popover"
                id="summary-prompt-popover"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (controller.saveSummaryPrompt(summaryPromptDraft)) {
                    setSummaryPromptOpen(false);
                  }
                }}
                role="dialog"
              >
                <div className="summary-prompt-heading">
                  <div>
                    <div className="summary-prompt-title">
                      Summary instructions
                    </div>
                    <p id="summary-prompt-help">
                      Used for one-click TL;DRs. The source text is added
                      separately.
                    </p>
                  </div>
                  {snapshot.summaryPromptCustomized && (
                    <span className="summary-prompt-badge">Custom</span>
                  )}
                </div>
                <textarea
                  aria-describedby="summary-prompt-help summary-prompt-count"
                  aria-label="Custom summary instructions"
                  autoFocus
                  id="summary-prompt-input"
                  maxLength={SUMMARY_PROMPT_MAX_CHARS}
                  onChange={(event) =>
                    setSummaryPromptDraft(event.currentTarget.value)
                  }
                  rows={7}
                  spellCheck
                  value={summaryPromptDraft}
                />
                <div className="summary-prompt-actions">
                  <span id="summary-prompt-count">
                    {summaryPromptDraft.length.toLocaleString()} /{" "}
                    {SUMMARY_PROMPT_MAX_CHARS.toLocaleString()}
                  </span>
                  <div>
                    <Button
                      id="summary-prompt-reset"
                      onClick={() => {
                        controller.resetSummaryPrompt();
                        setSummaryPromptDraft(
                          TldrPanelLogic.defaultSummaryPrompt(
                            snapshot.summaryLength
                          )
                        );
                      }}
                      size="sm"
                      type="button"
                      variant="ghost"
                    >
                      Reset
                    </Button>
                    <Button
                      disabled={!summaryPromptDraft.trim()}
                      id="summary-prompt-save"
                      size="sm"
                      type="submit"
                    >
                      Save
                    </Button>
                  </div>
                </div>
              </form>
            )}
          </div>
          <button
            className="disconnect-button"
            hidden={!snapshot.connected}
            id="disconnect"
            onClick={() => void controller.disconnect()}
            type="button"
          >
            Disconnect
          </button>
        </div>
      </footer>

      {/*
        Anchored to the composer instead of the viewport so a multi-line
        draft can never sit underneath it. Permanently mounted: a live region
        that is added to the DOM at the moment it gets text is not announced.
      */}
      <div aria-live="polite" className="toast-region" role="status">
        <div className="toast" hidden={!snapshot.toast} id="toast">
          {/* Keyed by sequence so a repeated identical toast re-announces. */}
          <span key={snapshot.toastSeq}>{snapshot.toast}</span>
        </div>
      </div>
    </div>
  );
}
