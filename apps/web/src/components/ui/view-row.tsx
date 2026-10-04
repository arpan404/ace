import { cn } from "@/lib/cn.ts";
import type { ReactNode } from "react";
import { Icon, type IconGlyph } from "@/components/icon.tsx";

/**
 * A second-sidebar row for list-detail views (Deck, Skills, More, Automations): a 26px icon
 * tile, a title, a muted description and an optional age. Put `viewRowClass` on the Link or
 * button that wraps `ViewRowBody`; the router's `data-status="active"` marks the selection.
 */
export const viewRowClass = cn(
  "group grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 rounded-card px-[11px] py-[9px] text-left outline-none transition-colors duration-(--dur-1)",
  "hover:bg-sidebar-accent focus-visible:shadow-[inset_0_0_0_1.5px_color-mix(in_oklab,var(--ring)_60%,transparent)]",
  "data-[status=active]:bg-[color-mix(in_oklab,var(--foreground)_7%,transparent)] aria-[current=page]:bg-[color-mix(in_oklab,var(--foreground)_7%,transparent)]",
);

export function ViewRowBody(props: {
  icon: IconGlyph;
  title: ReactNode;
  description?: ReactNode;
  /** Age or a short state, bottom right. */
  meta?: ReactNode;
  /** Title in the monospace face (skill and command names). */
  mono?: boolean;
  /** Medium-weight title: the row needs the user. */
  strong?: boolean;
}) {
  return (
    <>
      <span className="mt-px grid size-[26px] place-items-center rounded-sm bg-secondary text-muted-foreground group-data-[status=active]:text-foreground">
        <Icon icon={props.icon} size={14} />
      </span>
      <span className="min-w-0">
        <span
          className={cn(
            "block truncate text-ui leading-[1.3] text-foreground",
            props.mono && "font-mono text-[12.5px]",
            props.strong ? "font-medium" : "font-normal",
          )}
        >
          {props.title}
        </span>
        {props.description && (
          <span className="mt-0.5 line-clamp-2 block text-[12px] leading-[1.35] text-subtle-foreground">
            {props.description}
          </span>
        )}
        {props.meta && (
          <span className="mt-1 block text-right text-xs text-subtle-foreground tabular-nums">
            {props.meta}
          </span>
        )}
      </span>
    </>
  );
}

/** Group label inside a view's list in the sidebar ("Gated", "Plugins"). */
export function ViewRowSection(props: { label: string; children: ReactNode }) {
  return (
    <section aria-label={props.label} className="mt-3 first:mt-1">
      <h3 className="px-[11px] pb-1.5 text-[12px] font-medium text-subtle-foreground">
        {props.label}
      </h3>
      <ul className="flex flex-col gap-px">{props.children}</ul>
    </section>
  );
}

/**
 * A view's list in the sidebar that failed while the main pane explains why: one quiet line and a way
 * to read it again, so the failure isn't told twice in two voices.
 */
export function ViewSidebarError(props: { onRetry(): void }) {
  return (
    <p className="flex items-center gap-1.5 px-[11px] pt-3 text-sm text-subtle-foreground">
      Couldn't load the list.
      <button
        type="button"
        onClick={props.onRetry}
        className="rounded-sm font-medium text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:shadow-[0_0_0_2px_color-mix(in_oklab,var(--ring)_40%,transparent)]"
      >
        Try again
      </button>
    </p>
  );
}
