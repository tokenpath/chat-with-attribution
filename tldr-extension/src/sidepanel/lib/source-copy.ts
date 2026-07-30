// Every user-facing string about the captured source is derived here from the
// controller's structured `sourceType` / `contextStatus` fields. Nothing in the
// view branches on a display string.
import type { ContextSourceType, PanelSnapshot } from "@/controller";

/** Uppercase rail label on the source card. */
export function sourceLabel(sourceType: ContextSourceType) {
  if (sourceType === "pdf") return "Entire PDF";
  if (sourceType === "video") return "Video transcript";
  if (sourceType === "page") return "Entire page";
  return "Selected text";
}

/** Shown in the source card while a capture is still being read. */
export function readingText(sourceType: ContextSourceType) {
  if (sourceType === "pdf") return "Reading the full PDF…";
  if (sourceType === "video") return "Reading this video’s transcript…";
  return "Reading this page…";
}

export function composerPlaceholder(snapshot: PanelSnapshot) {
  if (snapshot.contextStatus === "reading") {
    if (snapshot.sourceType === "pdf") return "Reading PDF…";
    if (snapshot.sourceType === "video") return "Reading transcript…";
    return "Reading page…";
  }
  if (!snapshot.hasContext) return "Ask about this page…";
  if (snapshot.sourceType === "pdf") return "Ask about the PDF…";
  if (snapshot.sourceType === "video") return "Ask about the video…";
  if (snapshot.sourceType === "page") return "Ask about the page…";
  return "Ask about the selection…";
}

/**
 * Fallback prompt for the Summarize starter when there is no live context yet.
 * With a context, `controller.runSummary()` owns the wording.
 */
export function summaryFallbackPrompt(snapshot: PanelSnapshot) {
  if (!snapshot.hasContext) return "Summarize this page.";
  if (snapshot.sourceType === "pdf") return "Summarize this PDF.";
  if (snapshot.sourceType === "video") return "Summarize this video.";
  if (snapshot.sourceType === "page") return "Summarize this page.";
  return "Summarize this selection.";
}
