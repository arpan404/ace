import type { ReactNode } from "react";

/**
 * One block of the sidebar: "Reviewers", "Labels", "Milestone"… as a small heading with its
 * action at the right, what it holds under it, and a hairline below.
 */
export function DetailRow(props: { label: string; children: ReactNode; action?: ReactNode }) {
  return (
    <div className="border-b border-border py-3 text-ui first:pt-0 last:border-b-0">
      <div className="flex h-6 items-center gap-2">
        <h4 className="min-w-0 flex-1 truncate text-xs font-semibold text-muted-foreground">
          {props.label}
        </h4>
        {/* The action's words, not its box, end on the column's edge. */}
        {props.action && (
          <div className="-mr-1.5 flex shrink-0 items-center [&_button]:font-normal [&_button]:text-subtle-foreground [&_button:hover]:text-foreground">
            {props.action}
          </div>
        )}
      </div>
      <div className="mt-1 flex min-w-0 flex-col gap-0.5">{props.children}</div>
    </div>
  );
}
