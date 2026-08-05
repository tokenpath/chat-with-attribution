import { LoaderCircleIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export function Spinner({ className }: { className?: string }) {
  return (
    <LoaderCircleIcon
      aria-hidden="true"
      className={cn("size-4 animate-spin", className)}
    />
  );
}
