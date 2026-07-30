import { useEffect, useRef } from "react";
import {
  createAnswerHighlightRegistry,
  type AnswerHighlightRegistry,
} from "@/lib/answer-highlights";

/**
 * Create the panel's answer-highlight registry and tear it down with the
 * component that owns it. The registry is passed down explicitly so every
 * consumer can be rendered with a stub in a test.
 */
export function useAnswerHighlights(): AnswerHighlightRegistry {
  const registry = useRef<AnswerHighlightRegistry | null>(null);
  registry.current ||= createAnswerHighlightRegistry();

  useEffect(() => {
    const owned = registry.current;
    return () => owned?.dispose();
  }, []);

  return registry.current;
}
