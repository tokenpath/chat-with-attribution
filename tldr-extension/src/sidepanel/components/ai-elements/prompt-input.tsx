// Adapted from Vercel AI Elements' PromptInput. The extension intentionally
// keeps only the text composer surface; attachments, model selection, screen
// capture, and speech are not part of the TokenPath request contract.
// https://elements.ai-sdk.dev/components/prompt-input
"use client";

import { CornerDownLeftIcon, XIcon } from "lucide-react";
import type {
  ComponentProps,
  FormEvent,
  HTMLAttributes,
  KeyboardEventHandler,
} from "react";
import { useCallback, useState } from "react";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupButton,
  InputGroupTextarea,
} from "@/components/ui/input-group";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

export interface PromptInputMessage {
  text: string;
}

export type PromptInputProps = Omit<
  HTMLAttributes<HTMLFormElement>,
  "onSubmit"
> & {
  onSubmit: (
    message: PromptInputMessage,
    event: FormEvent<HTMLFormElement>
  ) => void | Promise<void>;
};

export const PromptInput = ({
  className,
  onSubmit,
  children,
  ...props
}: PromptInputProps) => {
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const formData = new FormData(event.currentTarget);
      const text = String(formData.get("message") || "");
      return onSubmit({ text }, event);
    },
    [onSubmit]
  );

  return (
    <form
      className={cn("w-full", className)}
      onSubmit={handleSubmit}
      {...props}
    >
      <InputGroup className="overflow-hidden">{children}</InputGroup>
    </form>
  );
};

export type PromptInputTextareaProps = ComponentProps<
  typeof InputGroupTextarea
>;

export const PromptInputTextarea = ({
  onKeyDown,
  className,
  placeholder = "What would you like to know?",
  ...props
}: PromptInputTextareaProps) => {
  const [isComposing, setIsComposing] = useState(false);

  const handleKeyDown: KeyboardEventHandler<HTMLTextAreaElement> = useCallback(
    (event) => {
      onKeyDown?.(event);
      if (event.defaultPrevented || event.key !== "Enter") return;
      if (event.shiftKey || isComposing || event.nativeEvent.isComposing) return;

      event.preventDefault();
      const submitButton = event.currentTarget.form?.querySelector(
        'button[type="submit"]'
      ) as HTMLButtonElement | null;
      if (!submitButton?.disabled) event.currentTarget.form?.requestSubmit();
    },
    [isComposing, onKeyDown]
  );

  return (
    <InputGroupTextarea
      className={cn("max-h-36 min-h-12", className)}
      name="message"
      onCompositionEnd={() => setIsComposing(false)}
      onCompositionStart={() => setIsComposing(true)}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      {...props}
    />
  );
};

export type PromptInputFooterProps = Omit<
  ComponentProps<typeof InputGroupAddon>,
  "align"
>;

export const PromptInputFooter = ({
  className,
  ...props
}: PromptInputFooterProps) => (
  <InputGroupAddon
    align="block-end"
    className={cn("justify-between gap-1", className)}
    {...props}
  />
);

export type PromptInputStatus = "ready" | "submitted" | "error";

export type PromptInputSubmitProps = ComponentProps<typeof InputGroupButton> & {
  status?: PromptInputStatus;
};

export const PromptInputSubmit = ({
  className,
  status = "ready",
  children,
  ...props
}: PromptInputSubmitProps) => {
  const icon =
    status === "submitted" ? (
      <Spinner />
    ) : status === "error" ? (
      <XIcon className="size-4" />
    ) : (
      <CornerDownLeftIcon className="size-4" />
    );

  return (
    <InputGroupButton
      aria-label="Send message"
      className={cn("rounded-lg", className)}
      size="icon-sm"
      type="submit"
      {...props}
    >
      {children ?? icon}
    </InputGroupButton>
  );
};
