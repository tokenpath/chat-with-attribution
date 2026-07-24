import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  TextareaHTMLAttributes,
} from "react";
import { Button, type ButtonProps } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function InputGroup({
  className,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn(
        "group/input relative flex w-full min-w-0 flex-col rounded-xl border border-input bg-background shadow-xs transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/25",
        className
      )}
      data-slot="input-group"
      {...props}
    />
  );
}

export function InputGroupTextarea({
  className,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={cn(
        "field-sizing-content min-h-12 w-full resize-none border-0 bg-transparent px-3.5 py-3 text-sm leading-5 text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      data-slot="input-group-control"
      {...props}
    />
  );
}

type InputGroupAddonProps = HTMLAttributes<HTMLDivElement> & {
  align?: "block-start" | "block-end" | "inline-start" | "inline-end";
};

export function InputGroupAddon({
  className,
  align = "block-end",
  ...props
}: InputGroupAddonProps) {
  return (
    <div
      className={cn(
        "flex items-center gap-1 px-2.5 pb-2.5 text-xs text-muted-foreground",
        align === "block-start" && "order-first pb-0 pt-2.5",
        align === "block-end" && "order-last",
        className
      )}
      data-align={align}
      data-slot="input-group-addon"
      {...props}
    />
  );
}

export function InputGroupButton({
  className,
  ...props
}: ButtonProps & ButtonHTMLAttributes<HTMLButtonElement>) {
  return <Button className={cn("rounded-lg", className)} {...props} />;
}
