import { formatClock } from "@ace/ui-core";
import { useId, useState, type ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { StaticRow, TranscriptRow, rowDetailIndent } from "./transcript-row.tsx";

/**
 * Something that happened to the thread rather than in the conversation ("Resumed after
 * restart", "Stopped", "Context compacted"), as one muted row in the weight of "Worked for":
 * a glyph, the words, the time at the right. What ace sent on the person's behalf opens from
 * the row itself, folded until asked for. Never a centred divider, never focused by itself.
 */
export function SystemRow(props: {
  text: string;
  icon: ReactNode;
  /** When it happened, ms since the epoch. */
  at?: number | undefined;
  /** What opening the row shows; without it the row is plain text. */
  children?: ReactNode;
  role?: "note" | "status";
}) {
  const [open, setOpen] = useState(false);
  const body = useId();
  const parts = {
    lead: props.icon,
    title: props.text,
    meta: props.at === undefined ? undefined : formatClock(props.at),
  };
  return (
    <div role={props.role ?? "note"} aria-label={props.text}>
      {props.children ? (
        <TranscriptRow
          {...parts}
          expanded={open}
          controls={body}
          label={props.text}
          onToggle={() => setOpen(!open)}
        />
      ) : (
        <StaticRow {...parts} />
      )}
      {props.children && open && (
        <div
          id={body}
          className={cn(
            "fx-rise-in mt-1 max-h-72 overflow-auto text-xs whitespace-pre-wrap break-words text-muted-foreground",
            rowDetailIndent,
          )}
        >
          {props.children}
        </div>
      )}
    </div>
  );
}
