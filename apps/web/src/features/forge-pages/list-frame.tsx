import type { ReactNode } from "react";
import { cn } from "@/lib/cn.ts";
import { useRememberList } from "./last-list.ts";
import { useListScroll } from "./list-scroll.ts";

const barLabels = {
  inbox: "Inbox filters",
  pulls: "Pull request filters",
  issues: "Issue filters",
} as const;

/**
 * A list page (Pull requests, Issues, Inbox) laid out the way GitHub lays out its own: a bar
 * with the project menu, the search line and the page's one action; then one bordered,
 * rounded box whose header row holds the state toggles and filter menus, with the rows inside
 * it. The inbox puts its filter column to the left of the box. The page keeps to the same
 * centred column as a pull request's page, so every Code review page lines up.
 */
export function ListFrame(props: {
  kind: "inbox" | "pulls" | "issues";
  /** The bar over the box: project menu, search line, actions. */
  bar: ReactNode;
  /** Status lines under the bar (the merge strip, a partial answer). */
  strip?: ReactNode;
  /** The inbox's filter column, left of the box on a wide page. */
  side?: ReactNode;
  /** The box's header row: state toggles on the left, menus on the right. */
  header: ReactNode;
  /** Under the box: Load more. */
  after?: ReactNode;
  /** A line pinned at the foot of the page (the inbox's keys). */
  footer?: ReactNode;
  /** The list's address (filters, sort, search): where it was scrolled is kept per address. */
  address: string;
  /** Its rows are on screen, so a kept position can be restored. */
  ready: boolean;
  children: ReactNode;
}) {
  const { ref, onScroll } = useListScroll(props.kind, props.address, props.ready);
  useRememberList(props.kind);
  return (
    <div
      ref={ref}
      className={cn("@container/page flex h-full flex-col overflow-y-auto", forgeGutter)}
      onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
    >
      <div className={cn(pageColumn, "flex-1 px-(--forge-gutter) pt-4 pb-8")}>
        <div
          role="toolbar"
          aria-label={barLabels[props.kind]}
          className="@container/bar flex min-w-0 flex-wrap items-center gap-2"
        >
          {props.bar}
        </div>
        {props.strip}
        <div className="flex min-w-0 items-start gap-6 pt-4">
          {props.side && (
            <aside
              aria-label="Notification filters"
              className="sticky top-4 hidden w-52 shrink-0 @min-[52rem]/page:block"
            >
              {props.side}
            </aside>
          )}
          <div className="min-w-0 flex-1">
            <section className="rounded-lg border border-border">
              <div className="sticky top-0 z-[2] flex min-h-12 min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-t-lg border-b border-border bg-muted px-2 py-1.5">
                {props.header}
              </div>
              {props.children}
            </section>
            {props.after}
          </div>
        </div>
      </div>
      {props.footer && (
        <div className="sticky bottom-0 z-[2] border-t border-border bg-background">
          <div className={cn(pageColumn, "px-(--forge-gutter)")}>{props.footer}</div>
        </div>
      )}
    </div>
  );
}

/** The lists' column: as wide as a pull request's or an issue's page, centred. */
const pageColumn = "mx-auto w-full max-w-[64rem]";

/** The page's one gutter: 16px in a narrow column, 32px beside it. */
export const forgeGutter = "[--forge-gutter:1rem] sm:[--forge-gutter:2rem]";

/** A row inside the box: its own padding, hairline under it but the last. */
export const boxRowClass =
  "flex w-full min-w-0 items-start gap-2 px-4 py-2 text-left transition-colors duration-(--motion-fast) hover:bg-hover focus-ring-inset";
