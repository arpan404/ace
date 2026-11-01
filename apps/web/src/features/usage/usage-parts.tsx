import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";

/** A Usage section's heading: a quiet label, with its controls or note at the right. */
export function SectionHeading(props: { id: string; title: string; children?: ReactNode }) {
  return (
    <div className="mt-10 mb-1 flex min-h-7 items-center gap-3">
      <h2 id={props.id} className="text-xs font-semibold text-subtle-foreground">
        {props.title}
      </h2>
      {props.children && (
        <div className="ml-auto flex items-center gap-3 text-xs text-subtle-foreground">
          {props.children}
        </div>
      )}
    </div>
  );
}

/** One figure with its label above it. */
export function Stat(props: {
  label: string;
  value: string;
  tone?: "good" | undefined;
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
        {props.note && (
          <span className="ml-1 text-xs font-normal text-subtle-foreground">{props.note}</span>
        )}
      </dd>
    </div>
  );
}
