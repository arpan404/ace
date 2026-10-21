import type { ReactNode } from "react";

/**
 * The top of a pull request's or issue's page: back, the title in large type with its number,
 * the page's actions at the right, then the state badge and who opened it. One layout for both
 * pages, so they read the same.
 */
export function WorkHeading(props: {
  /** Back to the list. */
  back: ReactNode;
  /** The title as text, or an editor in its place. */
  title: ReactNode;
  actions?: ReactNode;
  /** The state badge (`StateBadge`). */
  badge: ReactNode;
  /** Who opened it and what it does: "mira opened 1d ago", "sam wants to merge into main". */
  byline: ReactNode;
}) {
  return (
    <>
      <div className="flex items-start gap-2">
        {props.back}
        <div className="min-w-0 flex-1">{props.title}</div>
        {props.actions && <div className="flex shrink-0 items-center gap-1">{props.actions}</div>}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 pl-8 text-ui text-muted-foreground">
        {props.badge}
        {props.byline}
      </div>
    </>
  );
}

/** The title in large type, followed by its number; it wraps rather than truncating. */
export function WorkTitle(props: { text: string; number: number; trailing?: ReactNode }) {
  return (
    <div className="group/title flex min-w-0 items-start gap-1">
      <h2 className="min-w-0 text-xl font-semibold tracking-title text-foreground">
        {props.text}{" "}
        <span className="font-normal text-subtle-foreground tabular-nums">#{props.number}</span>
      </h2>
      {props.trailing}
    </div>
  );
}
