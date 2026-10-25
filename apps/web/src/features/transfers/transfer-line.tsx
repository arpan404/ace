import type { ReactNode } from "react";
import { Button } from "@/components/ui/button.tsx";

export interface LineAction {
  label: string;
  run(): void;
  disabled?: boolean;
}

/**
 * A transfer in one sentence with its text buttons at the right: "Sending to Studio · 312 MB of
 * 1.2 GB  Cancel", "Continued on Studio  Open". No glyph, no tint (ADR 0101).
 */
export function TransferLine(props: {
  words: string;
  actions: readonly LineAction[];
  /** The composer strip's indicators, when it is the strip. */
  indicators?: ReactNode;
  alert?: boolean;
}) {
  return (
    <div
      role={props.alert ? "alert" : "status"}
      className="flex h-7 min-w-0 items-center gap-1.5 px-1 text-xs"
    >
      <span className="min-w-0 flex-1 truncate text-foreground tabular-nums" title={props.words}>
        {props.words}
      </span>
      {props.indicators}
      {props.actions.map((action) => (
        <Button
          key={action.label}
          variant="ghost"
          size="xs"
          disabled={action.disabled}
          onClick={action.run}
        >
          {action.label}
        </Button>
      ))}
    </div>
  );
}
