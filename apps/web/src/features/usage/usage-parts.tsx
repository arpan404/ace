import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";

/*
 * The Usage page's one spacing scale: a section starts 32px under the one before it with its
 * heading (`text-ui` 600 in muted ink), content 12px under the heading, 24px between groups.
 */

/** A section's heading, with a quiet note or its controls at the right. */
export function SectionHeading(props: { id: string; title: string; children?: ReactNode }) {
  return (
    <div className="mt-8 mb-3 flex h-7 items-center gap-3">
      <h2 id={props.id} className="text-ui font-semibold text-muted-foreground">
        {props.title}
      </h2>
      {props.children && (
        <div className="ml-auto flex items-center gap-3 text-xs text-subtle-foreground tabular-nums">
          {props.children}
        </div>
      )}
    </div>
  );
}

/** One figure with its label above it; `note` is a quiet line under the figure. */
export function Stat(props: {
  label: string;
  value: string;
  tone?: "good" | undefined;
  unit?: string | undefined;
  note?: string | undefined;
  testId?: string | undefined;
}) {
  return (
    <div className="min-w-0" data-testid={props.testId}>
      <dt className="text-xs text-subtle-foreground">{props.label}</dt>
      <dd
        className={cn(
          "text-xl leading-tight font-semibold tabular-nums",
          props.tone === "good" && "text-status-done",
        )}
      >
        {props.value}
        {props.unit && (
          <span className="ml-1 text-xs font-normal text-subtle-foreground">{props.unit}</span>
        )}
      </dd>
      {props.note && <dd className="text-xs text-muted-foreground">{props.note}</dd>}
    </div>
  );
}
