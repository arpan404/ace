import type { ReactNode } from "react";
import { ArrowLeftIcon } from "@phosphor-icons/react";

/**
 * The top of a pull request's or issue's page: a quiet "← Pull requests" back to the list, the
 * title in large type with its number, the page's actions at the right, then the state badge and
 * who opened it. Everything starts on the page's gutter like the rest of the page. One layout
 * for both pages, so they read the same.
 */
export function WorkHeading(props: {
  /** Back to the list, named by it: "Pull requests", "Issues". */
  back?: { label: string; onBack(): void } | undefined;
  /** The title as text, or an editor in its place. */
  title: ReactNode;
  actions?: ReactNode;
  /** The state badge (`StateBadge`); none on a page for something not made yet. */
  badge?: ReactNode;
  /** Who opened it and what it does: "mira opened 1d ago", "sam wants to merge into main". */
  byline?: ReactNode;
}) {
  return (
    <>
      {props.back && (
        <button
          type="button"
          aria-label={`Back to ${props.back.label.toLowerCase()}`}
          onClick={props.back.onBack}
          className="-ml-1 mb-2 inline-flex h-6 items-center gap-1 rounded-sm px-1 text-ui text-muted-foreground transition-colors duration-(--motion-fast) focus-ring touch-hit hover:text-foreground"
        >
          <ArrowLeftIcon aria-hidden size={14} />
          {props.back.label}
        </button>
      )}
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">{props.title}</div>
        {props.actions && (
          <div className="-mr-1 flex shrink-0 items-center gap-1">{props.actions}</div>
        )}
      </div>
      {(props.badge || props.byline) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-ui text-muted-foreground">
          {props.badge}
          {props.byline}
        </div>
      )}
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
