// One registry owns the two document-scoped CSS custom highlights the panel
// paints over answer text. It is created per panel instance (never at module
// scope) so a test can render an answer, assert the ranges it registered, and
// dispose of it without leaking into the next test.

export const AVAILABLE_ANSWER_HIGHLIGHT = "tokenpath-answer-attributable";
export const HOVERED_ANSWER_HIGHLIGHT = "tokenpath-answer-hover";

export interface AnswerHighlightRegistry {
  /** Every attributable phrase in one answer, underlined together. */
  setAvailable(messageId: string, ranges: Range[]): void;
  /** The single phrase the pointer or keyboard is currently on. */
  setHovered(messageId: string, ranges: Range[]): void;
  /** Drop one answer's ranges when it unmounts or loses its source map. */
  release(messageId: string): void;
  /** Drop everything this registry owns. */
  dispose(): void;
}

export function createAnswerHighlightRegistry(): AnswerHighlightRegistry {
  const groups = new Map<string, Map<string, Range[]>>([
    [AVAILABLE_ANSWER_HIGHLIGHT, new Map()],
    [HOVERED_ANSWER_HIGHLIGHT, new Map()],
  ]);

  const sync = (name: string) => {
    if (!CSS.highlights || typeof Highlight !== "function") return;
    const ranges = [...(groups.get(name)?.values() ?? [])].flat();
    if (ranges.length === 0) {
      CSS.highlights.delete(name);
      return;
    }
    CSS.highlights.set(name, new Highlight(...ranges));
  };

  const set = (name: string, messageId: string, ranges: Range[]) => {
    const group = groups.get(name);
    if (!group) return;
    if (ranges.length > 0) group.set(messageId, ranges);
    else group.delete(messageId);
    sync(name);
  };

  return {
    setAvailable(messageId, ranges) {
      set(AVAILABLE_ANSWER_HIGHLIGHT, messageId, ranges);
    },
    setHovered(messageId, ranges) {
      set(HOVERED_ANSWER_HIGHLIGHT, messageId, ranges);
    },
    release(messageId) {
      for (const [name, group] of groups) {
        if (group.delete(messageId)) sync(name);
      }
    },
    dispose() {
      for (const [name, group] of groups) {
        group.clear();
        sync(name);
      }
    },
  };
}
