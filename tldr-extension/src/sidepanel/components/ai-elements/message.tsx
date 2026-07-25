// Adapted from Vercel AI Elements:
// https://elements.ai-sdk.dev/components/message
"use client";

import type { ComponentProps, HTMLAttributes } from "react";
import { memo } from "react";
import { Streamdown } from "streamdown";
import { cn } from "@/lib/utils";

export type MessageRole = "user" | "assistant" | "system";

export type MessageProps = HTMLAttributes<HTMLDivElement> & {
  from: MessageRole;
};

export const Message = ({ className, from, ...props }: MessageProps) => (
  <div
    className={cn(
      "group flex w-full max-w-[95%] flex-col gap-2",
      from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
      className
    )}
    {...props}
  />
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({
  children,
  className,
  ...props
}: MessageContentProps) => (
  <div
    className={cn(
      "flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm",
      "group-[.is-user]:ml-auto group-[.is-user]:rounded-xl group-[.is-user]:bg-secondary group-[.is-user]:px-3.5 group-[.is-user]:py-2.5 group-[.is-user]:text-foreground",
      "group-[.is-assistant]:w-full group-[.is-assistant]:text-foreground",
      className
    )}
    {...props}
  >
    {children}
  </div>
);

export type MessageResponseProps = ComponentProps<typeof Streamdown>;

export const MessageResponse = memo(
  ({ className, ...props }: MessageResponseProps) => (
    <Streamdown
      className={cn(
        "size-full text-sm leading-6 [&>*:first-child]:mt-0 [&>*:last-child]:mb-0",
        className
      )}
      {...props}
    />
  ),
  (previous, next) =>
    previous.children === next.children &&
    previous.isAnimating === next.isAnimating &&
    previous.components === next.components &&
    previous.mode === next.mode &&
    previous.parseIncompleteMarkdown === next.parseIncompleteMarkdown
);

MessageResponse.displayName = "MessageResponse";
