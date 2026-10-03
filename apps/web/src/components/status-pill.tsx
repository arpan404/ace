import { cva } from "class-variance-authority";
import { cn } from "@/lib/cn.ts";
import type { Tone } from "@/lib/status.ts";

/** Tinted chip for the thread status chip, agent tree and Activity only (DESIGN-fable.md). */
const pill = cva(
  "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-[9px] text-[12px] font-medium whitespace-nowrap",
  {
    variants: {
      tone: {
        working:
          "bg-[color-mix(in_oklab,var(--status-working)_13%,transparent)] text-[color-mix(in_oklab,var(--status-working)_80%,var(--foreground))]",
        "needs-you":
          "bg-[color-mix(in_oklab,var(--status-needs-you)_13%,transparent)] text-[color-mix(in_oklab,var(--status-needs-you)_80%,var(--foreground))]",
        waiting:
          "bg-[color-mix(in_oklab,var(--status-waiting)_13%,transparent)] text-[color-mix(in_oklab,var(--status-waiting)_80%,var(--foreground))]",
        failed:
          "bg-[color-mix(in_oklab,var(--status-failed)_13%,transparent)] text-[color-mix(in_oklab,var(--status-failed)_80%,var(--foreground))]",
        done: "bg-[color-mix(in_oklab,var(--status-done)_13%,transparent)] text-[color-mix(in_oklab,var(--status-done)_80%,var(--foreground))]",
        idle: "bg-secondary text-muted-foreground",
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
