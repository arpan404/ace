import { useId, useRef, type ComponentProps, type ReactNode } from "react";
import { settingsGroup, useHashFlash } from "@/components/setting-row.tsx";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/cn.ts";

/*
 * Quiet list rows for overview pages (Settings › Fleet): a small tile, a title over one status
 * line, facts at the right, and actions that show under the pointer or focus. A group's rows
 * share one rounded surface, as a settings group's do, with hairlines between them.
 */

/** A group's rows on one rounded surface, hairlines between them. */
export function HairlineList(props: { children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col rounded-lg bg-surface-1 p-1", props.className)}>
      {props.children}
    </div>
  );
}

/** The small square a row leads with, holding a 15px glyph (hide the glyph if it says nothing). */
export function RowTile(props: { children: ReactNode; size?: "row" | "page" }) {
  return (
    <span
      className={cn(
        "grid shrink-0 place-items-center bg-surface-2 text-muted-foreground shadow-[inset_0_0_0_1px_var(--border)]",
        props.size === "page" ? "size-11 rounded-xl text-foreground" : "size-7 rounded-lg",
      )}
    >
      {props.children}
    </span>
  );
}

export type DotTone = "on" | "warn" | "off";

/** A state's 7px dot: on in the done colour, warn in the needs-you colour, off a faint grey. */
export function StateDot(props: { tone: DotTone }) {
  return (
    <span
      aria-hidden
      data-tone={props.tone}
      className={cn(
        "inline-block size-[7px] shrink-0 rounded-full",
        props.tone === "on" && "bg-status-done",
        props.tone === "warn" && "bg-status-needs-you",
        props.tone === "off" && "bg-subtle-foreground opacity-50",
      )}
    />
  );
}

/** A dot and its words, for a row's status line. */
export function StateWords(props: { tone: DotTone; children: ReactNode }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <StateDot tone={props.tone} />
      {props.children}
    </span>
  );
}

/**
 * A text action at a row's end. `reveal` keeps it hidden until the row is pointed at or holds
 * focus, and always shows it where there is no pointer to point with or the column is narrow.
 */
export function RowAction({
  reveal,
  className,
  ...props
}: ComponentProps<typeof Button> & { reveal?: boolean }) {
  return (
    <Button
      size="sm"
      variant="ghost"
      className={cn(
        "relative z-1",
        reveal &&
          "opacity-0 transition-opacity duration-(--motion-fast) group-focus-within/row:opacity-100 group-hover/row:opacity-100 pointer-coarse:opacity-100 @max-[560px]:opacity-100",
        className,
      )}
      {...props}
    />
  );
}

/** A row's title as the link or button that opens it, stretched over the whole row. */
export const rowLinkClass =
  "w-fit max-w-full truncate rounded-sm text-left text-ui text-foreground focus-ring after:absolute after:inset-0 after:content-['']";

/**
 * One row: tile, title (with a quiet tag), status line, facts and actions. When it opens
 * something the title is the link (`link`, styled with `rowLinkClass`) or button
 * (`onOpen`), stretched over the whole row; actions sit above it. `id` is a settings anchor: a
 * link naming it scrolls to the row and flashes it.
 */
export function HairlineRow(props: {
  tile?: ReactNode;
  title: ReactNode;
  /** Beside the title in the quiet tier ("this computer"). */
  tag?: ReactNode;
  sub?: ReactNode;
  /** Facts at the right in the subtle tier ("Linked", "2 min ago"). */
  meta?: ReactNode;
  actions?: ReactNode;
  id?: string | undefined;
  /** The open button's accessible name, if not its title. */
  label?: string | undefined;
  /** Opens a page: the title as a link, styled with `rowLinkClass`. */
  link?: ReactNode;
  /** Opens something here: the title is a button. */
  onOpen?: (() => void) | undefined;
  /** Under the row, inside it (a prompt it asks). */
  children?: ReactNode;
  /** Its control is wide (a choice): on a narrow column it drops under the words. */
  wide?: boolean;
  "data-row"?: string | undefined;
}) {
  const own = useRef<HTMLDivElement>(null);
  const flashing = useHashFlash(props.id, own);
  const opens = props.link !== undefined || props.onOpen !== undefined;
  const title = props.link ? (
    props.link
  ) : props.onOpen ? (
    <button type="button" aria-label={props.label} onClick={props.onOpen} className={rowLinkClass}>
      {props.title}
    </button>
  ) : (
    <span className="truncate text-ui text-foreground">{props.title}</span>
  );
  return (
    <div
      ref={own}
      id={props.id}
      data-row={props["data-row"]}
      data-flash={flashing || undefined}
      className={cn(
        // Inset 4px in its group's surface, so the wash's corners nest in the surface's.
        "group/row relative rounded-md px-3 transition-colors duration-(--motion-fast) hover:bg-hover focus-within:bg-hover",
        flashing && "bg-accent",
      )}
    >
      <div className="border-b border-border-soft last-row:border-b-0 group-hover/row:border-transparent group-focus-within/row:border-transparent">
        <div
          className={cn(
            "flex min-h-13 items-center gap-3 py-2.5",
            props.wide && "@max-[560px]:flex-wrap",
          )}
        >
          {props.tile}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 items-center gap-1.5">
              {title}
              {props.tag && (
                <span className="shrink-0 text-xs font-normal text-subtle-foreground">
                  {props.tag}
                </span>
              )}
            </div>
            {props.sub && (
              <div className="text-xs leading-relaxed text-muted-foreground">{props.sub}</div>
            )}
          </div>
          {props.meta && (
            <span className="shrink-0 text-xs whitespace-nowrap text-subtle-foreground tabular-nums">
              {props.meta}
            </span>
          )}
          {props.actions && (
            <div
              className={cn(
                "flex shrink-0 items-center gap-1",
                props.wide && "@max-[560px]:basis-full",
              )}
            >
              {props.actions}
            </div>
          )}
          {opens && (
            <span aria-hidden className="w-2.5 shrink-0 text-center text-subtle-foreground">
              ›
            </span>
          )}
        </div>
        {props.children}
      </div>
    </div>
  );
}
/** A group: its title with a quiet count, an optional line, then its rows on hairlines. */
export function RowGroup(props: {
  label: string;
  count?: number;
  note?: ReactNode;
  /** Text actions at the right of the title. */
  actions?: ReactNode;
  anchor?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section id={props.anchor} aria-labelledby={id} className={settingsGroup}>
      <div className="mb-1.5 flex min-h-7 items-center gap-2">
        <h3 id={id} className="text-base font-semibold text-foreground">
          {props.label}
        </h3>
        {props.count !== undefined && (
          <span className="text-xs text-subtle-foreground tabular-nums">{props.count}</span>
        )}
        {props.actions && (
          <div className="ml-auto flex items-center gap-1 [&>[data-variant=ghost]:last-child]:-mr-2.5">
            {props.actions}
          </div>
        )}
      </div>
      {props.note && <p className="-mt-1 mb-1.5 text-xs text-muted-foreground">{props.note}</p>}
      <HairlineList>{props.children}</HairlineList>
    </section>
  );
}
