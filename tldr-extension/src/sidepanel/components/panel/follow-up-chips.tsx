import { CornerDownRightIcon } from "lucide-react";

export interface FollowUpChip {
  /** Stable within one render pass; the question text is unique per row. */
  id: string;
  /** "summarize" and "detailed" are the depth ladder's fixed first chip. */
  kind: "summarize" | "detailed" | "generated";
  label: string;
  onSelect: () => void;
}

/**
 * Suggested follow-ups sit directly above the composer — where the reply
 * affordance already is, and where the eye lands after reading the answer.
 * Plain buttons: Tab reaches them and Enter or Space activates them.
 */
export function FollowUpChips({ chips }: { chips: FollowUpChip[] }) {
  if (chips.length === 0) return null;

  return (
    <div
      aria-label="Suggested follow-up questions"
      className="follow-ups shrink-0"
      id="follow-ups"
      role="group"
    >
      <div aria-hidden="true" className="follow-ups-label">
        Ask a follow-up
      </div>
      {chips.map((chip) => (
        <button
          className="follow-up-chip"
          data-chip-kind={chip.kind}
          key={chip.id}
          onClick={chip.onSelect}
          title={chip.label}
          type="button"
        >
          <CornerDownRightIcon aria-hidden="true" />
          <span>{chip.label}</span>
        </button>
      ))}
    </div>
  );
}
