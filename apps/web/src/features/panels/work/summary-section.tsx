import type { ReactNode } from "react";

/**
 * A Summary section: a small grey heading, how many it holds when that helps, an optional quiet
 * action at the right, then its rows. No card, no rule: sections part by space.
 */
export function Section(props: {
  name: string;
  count?: string | undefined;
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section aria-label={props.name} className="min-w-0 px-2">
      <div className="flex h-6 min-w-0 items-center gap-1.5">
        <h3 className="flex min-w-0 flex-1 items-baseline gap-1.5 text-xs font-medium text-subtle-foreground">
          {props.name}
          {props.count !== undefined && (
            <span className="font-normal tabular-nums">{props.count}</span>
          )}
        </h3>
        {props.aside}
      </div>
      {props.children}
    </section>
  );
}

/** A quiet text action in a section's heading or a row's grey line ("Clear", "Review"). */
export function QuietLink(props: {
  children: ReactNode;
  label?: string | undefined;
  onClick(): void;
  strong?: boolean | undefined;
}) {
  return (
    <button
      type="button"
      aria-label={props.label}
      onClick={props.onClick}
      className={
        props.strong
          ? "focus-ring rounded-xs font-medium text-foreground underline decoration-foreground/30 underline-offset-3 hover:decoration-foreground"
          : "focus-ring rounded-xs text-xs text-subtle-foreground hover:text-foreground"
      }
    >
      {props.children}
    </button>
  );
}
