// Adapted from Vercel AI Elements:
// https://elements.ai-sdk.dev/components/conversation
"use client";

import { ArrowDownIcon } from "lucide-react";
import type { ComponentProps } from "react";
import { useCallback, useSyncExternalStore } from "react";
import {
  StickToBottom,
  useStickToBottomContext,
} from "use-stick-to-bottom";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type ConversationProps = ComponentProps<typeof StickToBottom>;

const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function subscribeToReducedMotion(onChange: () => void) {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function reducedMotionSnapshot() {
  return window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

function useReducedMotion() {
  return useSyncExternalStore(
    subscribeToReducedMotion,
    reducedMotionSnapshot,
    () => false
  );
}

export const Conversation = ({
  className,
  ...props
}: ConversationProps) => {
  const animation = useReducedMotion() ? "auto" : "smooth";
  return (
    <StickToBottom
      className={cn("relative flex-1 overflow-y-hidden", className)}
      initial={animation}
      resize={animation}
      role="log"
      {...props}
    />
  );
};

export type ConversationContentProps = ComponentProps<
  typeof StickToBottom.Content
>;

export const ConversationContent = ({
  className,
  ...props
}: ConversationContentProps) => (
  <StickToBottom.Content
    className={cn("flex flex-col gap-8 p-4", className)}
    {...props}
  />
);

export type ConversationScrollButtonProps = ComponentProps<typeof Button>;

export const ConversationScrollButton = ({
  className,
  ...props
}: ConversationScrollButtonProps) => {
  const { isAtBottom, scrollToBottom } = useStickToBottomContext();
  const reducedMotion = useReducedMotion();
  const handleScrollToBottom = useCallback(() => {
    scrollToBottom(reducedMotion ? "auto" : undefined);
  }, [reducedMotion, scrollToBottom]);

  if (isAtBottom) return null;

  return (
    <Button
      aria-label="Scroll to latest message"
      className={cn(
        "absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-background shadow-md",
        className
      )}
      onClick={handleScrollToBottom}
      size="icon-sm"
      type="button"
      variant="outline"
      {...props}
    >
      <ArrowDownIcon className="size-4" />
    </Button>
  );
};
