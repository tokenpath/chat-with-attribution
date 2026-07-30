import { useRef } from "react";
import type { SummaryLength } from "@/controller";
import { cn } from "@/lib/utils";

const OPTIONS: Array<{ label: string; title: string; value: SummaryLength }> = [
  { label: "Short", title: "Short summaries", value: "low" },
  { label: "Medium", title: "Medium summaries", value: "medium" },
  { label: "Detailed", title: "Detailed summaries", value: "high" },
];

/**
 * Persistent Short / Medium / Detailed preference for the summary pathway.
 * Radiogroup semantics with roving focus: one tab stop, arrow keys move and
 * select, exactly like a native radio group.
 */
export function SummaryLengthControl({
  disabled = false,
  onChange,
  value,
}: {
  disabled?: boolean;
  onChange: (value: SummaryLength) => void;
  value: SummaryLength;
}) {
  const buttons = useRef<Array<HTMLButtonElement | null>>([]);
  const selectedIndex = Math.max(
    0,
    OPTIONS.findIndex((option) => option.value === value)
  );

  const moveTo = (index: number) => {
    const next = (index + OPTIONS.length) % OPTIONS.length;
    onChange(OPTIONS[next].value);
    buttons.current[next]?.focus();
  };

  return (
    <div
      aria-label="Summary length"
      className="summary-length"
      id="summary-length"
      onKeyDown={(event) => {
        if (disabled) return;
        if (event.key === "ArrowRight" || event.key === "ArrowDown") {
          event.preventDefault();
          moveTo(selectedIndex + 1);
        } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
          event.preventDefault();
          moveTo(selectedIndex - 1);
        } else if (event.key === "Home") {
          event.preventDefault();
          moveTo(0);
        } else if (event.key === "End") {
          event.preventDefault();
          moveTo(OPTIONS.length - 1);
        }
      }}
      role="radiogroup"
    >
      {OPTIONS.map((option, index) => (
        <button
          aria-checked={option.value === value}
          className={cn(
            "summary-length-option",
            option.value === value && "is-selected"
          )}
          disabled={disabled}
          key={option.value}
          onClick={() => onChange(option.value)}
          ref={(element) => {
            buttons.current[index] = element;
          }}
          role="radio"
          tabIndex={index === selectedIndex ? 0 : -1}
          title={option.title}
          type="button"
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
