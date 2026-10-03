import { cva } from "class-variance-authority";
import { cn } from "cn";
import type { Tone } from "@/lib/status.ts";

const pill = cva(
  "inline-flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap",
  {
    variants: {
      tone: {
        working: "bg-status-working-surface text-status-working",
        "needs-you": "bg-status-needs-you-surface text-status-needs-you",
        waiting: "bg-status-waiting-surface text-status-waiting",
        failed: "bg-status-failed-surface text-status-failed",
        done: "bg-status-done-surface text-status-done",
        idle: "bg-muted text-muted-foreground",
      },
    },
  },
);

/** Status is conveyed by text, never colour alone. */
export function StatusPill(props: { tone: Tone; label: string; className?: string }) {
  return (
    <span
      data-slot="status-pill"
      data-tone={props.tone}
      className={cn(pill({ tone: props.tone }), props.className)}
    >
      <span aria-hidden="true" className="size-1.5 rounded-full bg-current" />
      {props.label}
    </span>
  );
}
