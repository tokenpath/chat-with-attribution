import { ExternalLinkIcon, SquareIcon } from "lucide-react";
import { useState, type RefObject } from "react";
import {
  PromptInput,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";
import type { PanelController, PanelSnapshot } from "@/controller";
import { composerPlaceholder } from "@/lib/source-copy";

const TOKENPATH_DEVELOPER_URL =
  "https://tokenpath.ai/?utm_source=browse-with-tokenpath&utm_medium=product&utm_campaign=developer_cta";

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
  // Reading a page or PDF has nothing to ask about yet. A running turn does:
  // the composer stays usable so the next question can be drafted while the
  // answer streams, and only its submission is blocked.
  const isReading = snapshot.contextStatus === "reading";
  const canStop = snapshot.busy && !isReading;

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
        <PromptInputFooter className="justify-end">
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
        <button
          className="disconnect-button"
          hidden={!snapshot.connected}
          id="disconnect"
          onClick={() => void controller.disconnect()}
          type="button"
        >
          Disconnect
        </button>
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
