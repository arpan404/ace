import type { ReactNode } from "react";

/**
 * A Summary section: a small grey heading with how many it holds at its right when that helps,
 * then its content, which brings its own inset (a rounded group runs to the tab's edges).
 */
export function Section(props: { name: string; count?: string | undefined; children: ReactNode }) {
  return (
    <section aria-label={props.name} className="min-w-0">
      <h3 className="flex h-6 min-w-0 items-center gap-1.5 px-2 text-xs font-medium text-subtle-foreground">
        <span className="min-w-0 flex-1 truncate">{props.name}</span>
        {props.count !== undefined && (
          <span className="shrink-0 font-normal tabular-nums">{props.count}</span>
        )}
      </h3>
      {props.children}
    </section>
  );
}

/** A quiet text action in a line or a row ("Clear", "Show", "Open"). */
export function QuietLink(props: {
  children: ReactNode;
  label?: string | undefined;
  onClick(): void;
  strong?: boolean | undefined;
  expanded?: boolean | undefined;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      aria-expanded={props.expanded}
      onClick={props.onClick}
      className={
        props.strong
          ? "focus-ring rounded-xs font-medium text-foreground underline decoration-foreground/30 underline-offset-3 hover:decoration-foreground"
          : "focus-ring rounded-xs text-subtle-foreground underline decoration-border underline-offset-3 hover:text-foreground"
      }
    >
      {props.children}
    </button>
  );
}
