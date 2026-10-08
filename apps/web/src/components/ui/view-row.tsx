import { cn } from "@/lib/cn.ts";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type KeyboardEventHandler,
  type ReactNode,
  type RefCallback,
} from "react";
import { Icon, type IconGlyph } from "@/components/icon.tsx";

/**
 * A second-sidebar row for list-detail views (Skills, More, Automations): a 26px icon
 * tile, a title, a muted description and an optional age. Put `viewRowClass` on the Link or
 * button that wraps `ViewRowBody`; the router's `data-status="active"` marks the selection.
 */
export const viewRowClass = cn(
  "group grid w-full grid-cols-[auto_minmax(0,1fr)] gap-x-2.5 rounded-card px-[11px] py-[9px] text-left transition-colors duration-(--dur-1)",
  "hover:bg-sidebar-accent focus-ring-inset",
  "data-[status=active]:bg-foreground/8 aria-[current=page]:bg-foreground/8",
);

export function ViewRowBody(props: {
  icon: IconGlyph;
  title: ReactNode;
  description?: ReactNode;
  /** Age or a short state: bottom right, or at the end of the title line with `metaInline`. */
  meta?: ReactNode;
  /** Put `meta` on the title line, so the row is one line shorter. */
  metaInline?: boolean;
  /** Title in the monospace face (skill and command names). */
  mono?: boolean;
  /** Medium-weight title: the row needs the user. */
  strong?: boolean;
}) {
  const title = (
    <span
      data-view-row-title=""
      className={cn(
        "block truncate text-ui leading-[1.3] text-foreground",
        props.mono && "font-mono text-sm",
        props.strong ? "font-medium" : "font-normal",
        props.metaInline && "min-w-0 flex-1",
      )}
    >
      {props.title}
    </span>
  );
  return (
    <>
      <span className="mt-px grid size-[26px] place-items-center rounded-sm bg-secondary text-muted-foreground group-data-[status=active]:text-foreground">
        <Icon icon={props.icon} size={14} />
      </span>
      <span className="min-w-0">
        {props.metaInline && props.meta ? (
          <span className="flex items-baseline gap-2">
            {title}
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
              {props.meta}
            </span>
          </span>
        ) : (
          title
        )}
        {props.description && (
          <span className="mt-0.5 line-clamp-2 block text-sm leading-[1.35] text-muted-foreground">
            {props.description}
          </span>
        )}
        {props.meta && !props.metaInline && (
          <span className="mt-1 block text-right text-xs text-muted-foreground tabular-nums">
            {props.meta}
          </span>
        )}
      </span>
    </>
  );
}

/** Group label inside a view's list in the sidebar ("Needs you", "Plugins"). */
export function ViewRowSection(props: { label: string; children: ReactNode }) {
  return (
    <section aria-label={props.label} className="mt-3 first:mt-1">
      <h3 className="px-[11px] pb-1.5 text-sm font-medium text-muted-foreground">{props.label}</h3>
      <ul className="flex flex-col gap-px">{props.children}</ul>
    </section>
  );
}

/** The rows of a view list: links and buttons around a `ViewRowBody`, or marked `data-view-row`. */
function rowsOf(list: HTMLElement): HTMLElement[] {
  const rows = new Set<HTMLElement>();
  for (const element of list.querySelectorAll<HTMLElement>(
    "[data-view-row-title], [data-view-row]",
  )) {
    const row = element.hasAttribute("data-view-row")
      ? element
      : element.closest<HTMLElement>("a[href], button");
    if (row && list.contains(row)) rows.add(row);
  }
  return [...rows].filter((row) => !row.hasAttribute("disabled") && !row.closest("[hidden]"));
}

const titleOf = (row: HTMLElement) =>
  (row.querySelector("[data-view-row-title]")?.textContent ?? row.textContent ?? "")
    .trim()
    .toLowerCase();

/** The row that takes Tab: the focused one, else the selected one, else the first. */
function homeRow(rows: HTMLElement[]): HTMLElement | undefined {
  const active = document.activeElement;
  return (
    rows.find((row) => row === active) ??
    rows.find(
      (row) => row.getAttribute("aria-current") === "page" || row.dataset.status === "active",
    ) ??
    rows[0]
  );
}

/**
 * Keyboard for a view's list in the sidebar (Skills, More, Automations): the list is
 * one Tab stop, ↑/↓ move between rows, Home/End jump to the ends, and typing a letter moves
 * to the next row whose title starts with it. Enter is the row's own (it is a link or button).
 * Spread the result on the element that holds the rows.
 */
export function useViewListKeys<T extends HTMLElement>(): {
  ref: RefCallback<T>;
  onKeyDown: KeyboardEventHandler<T>;
} {
  const [list, setList] = useState<T | null>(null);
  const listRef = useRef<T | null>(null);
  const ref = useCallback<RefCallback<T>>((element) => {
    listRef.current = element;
    setList(element);
  }, []);

  // Roving tabindex, kept right as rows come, go and change selection.
  useEffect(() => {
    if (!list) return;
    const rove = () => {
      const rows = rowsOf(list);
      const home = homeRow(rows);
      for (const row of rows) {
        const index = row === home ? "0" : "-1";
        if (row.getAttribute("tabindex") !== index) row.setAttribute("tabindex", index);
      }
    };
    rove();
    const observer = new MutationObserver(rove);
    observer.observe(list, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["aria-current", "data-status", "disabled", "hidden"],
    });
    list.addEventListener("focusin", rove);
    return () => {
      observer.disconnect();
      list.removeEventListener("focusin", rove);
    };
  }, [list]);

  const onKeyDown = useCallback((event: KeyboardEvent<T>) => {
    const element = listRef.current;
    if (!element || event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey)
      return;
    const rows = rowsOf(element);
    const current = rows.indexOf(document.activeElement as HTMLElement);
    if (current === -1) return;
    let next: number | undefined;
    if (event.key === "ArrowDown") next = Math.min(current + 1, rows.length - 1);
    else if (event.key === "ArrowUp") next = Math.max(current - 1, 0);
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = rows.length - 1;
    else if (event.key.length === 1 && /\S/.test(event.key)) {
      // Not prevented: a letter may also start a sequence shortcut ("g h").
      const letter = event.key.toLowerCase();
      const order = [...rows.slice(current + 1), ...rows.slice(0, current + 1)];
      const match = order.find((row) => titleOf(row).startsWith(letter));
      match?.focus();
      match?.scrollIntoView?.({ block: "nearest" });
      return;
    } else return;
    event.preventDefault();
    const target = rows[next];
    target?.focus();
    target?.scrollIntoView?.({ block: "nearest" });
  }, []);

  return { ref, onKeyDown };
}

/**
 * A view's list in the sidebar that failed while the main pane explains why: one quiet line and a way
 * to read it again, so the failure isn't told twice in two voices.
 */
export function ViewSidebarError(props: { onRetry(): void }) {
  return (
    <p className="flex items-center gap-1.5 px-[11px] pt-3 text-sm text-muted-foreground">
      Couldn't load the list.
      <button
        type="button"
        onClick={props.onRetry}
        className="rounded-sm font-medium text-foreground underline-offset-2 focus-ring hover:underline"
      >
        Try again
      </button>
    </p>
  );
}
