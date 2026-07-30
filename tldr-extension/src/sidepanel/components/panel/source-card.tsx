import { ChevronRightIcon } from "lucide-react";
import { useEffect, useState } from "react";
import type { PanelSnapshot } from "@/controller";
import { readingText, sourceLabel } from "@/lib/source-copy";
import { cn } from "@/lib/utils";

export function SourceCard({ snapshot }: { snapshot: PanelSnapshot }) {
  const [expanded, setExpanded] = useState(false);
  const label = sourceLabel(snapshot.sourceType);
  const isReading = snapshot.contextStatus === "reading";
  // A failed capture is reported as an error above the conversation, never as
  // source-card content.
  const visible = snapshot.hasContext || isReading;
  const bodyVisible = isReading || expanded;
  const body = isReading
    ? readingText(snapshot.sourceType)
    : snapshot.hasContext
      ? snapshot.contextText
      : "";

  useEffect(() => {
    setExpanded(false);
  }, [snapshot.contextText, snapshot.hasContext]);

  return (
    <section
      aria-label={label}
      className={cn(
        "source-card shrink-0",
        snapshot.hasContext && !expanded && "is-collapsed",
        expanded && "is-expanded"
      )}
      hidden={!visible}
      id="context"
    >
      <div
        className={cn(
          "source-card-header flex items-center justify-between gap-2",
          bodyVisible && "mb-1.5"
        )}
      >
        {snapshot.hasContext ? (
          <button
            aria-controls="context-text"
            aria-expanded={expanded}
            aria-label={
              expanded
                ? `Hide ${label.toLowerCase()}`
                : `Show ${label.toLowerCase()}`
            }
            className="source-toggle"
            id="context-toggle"
            onClick={() => setExpanded((open) => !open)}
            title={
              expanded
                ? `Hide ${label.toLowerCase()}`
                : `Show ${label.toLowerCase()}`
            }
            type="button"
          >
            <ChevronRightIcon aria-hidden="true" />
            <span className="source-label">{label}</span>
          </button>
        ) : (
          <div className="source-label">{label}</div>
        )}
      </div>
      <div className="context-text" hidden={!bodyVisible} id="context-text">
        {body}
      </div>
    </section>
  );
}
