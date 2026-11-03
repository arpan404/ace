import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { SearchField } from "@/components/search-field.tsx";
import { toolbarEdge } from "@/components/ui/rules.ts";
import { cn } from "@/lib/cn.ts";
import { useDebouncedValue } from "@/lib/debounced.ts";
import { useRememberList } from "./last-list.ts";
import { useListScroll } from "./list-scroll.ts";

/** GitHub's search allows 30 requests a minute: let typing settle before asking. */
const settleMs = 300;

function SearchBox(props: { label: string; value: string; onValue(value: string): void }) {
  const [text, setText] = useState(props.value);
  const input = useRef<HTMLInputElement | null>(null);
  const settled = useDebouncedValue(text, settleMs);
  const onValue = props.onValue;
  useEffect(() => {
    if (settled.trim() !== props.value.trim()) onValue(settled);
  }, [settled, props.value, onValue]);
  // ⌘F searches the list, the way it finds on the page in a browser; focus scrolls it in.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "f" || !(event.metaKey || event.ctrlKey) || event.shiftKey)
        return;
      event.preventDefault();
      input.current?.focus();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  return (
    <SearchField
      ref={input}
      label={props.label}
      placeholder="Search"
      value={text}
      onValueChange={setText}
      className="w-full"
    />
  );
}

/**
 * A list page's frame: one pinned bar over the rows, with the project menu, search, the quick
 * views and Filters on the left and the list's one action on the right. The page's title is the
 * top bar's (or the Code review panel's), so the bar carries none. While the bar has room the
 * quick views sit on its line; narrower, they take a line of their own under it. Nothing else
 * wraps: the search narrows first. Every band shares one gutter (`--forge-gutter`), so the bar
 * and the rows start on the same edge. Nothing changes size while scrolling, so the rows never
 * jump.
 */
export function ListFrame(props: {
  kind: "inbox" | "pulls" | "issues";
  /** The list's search; the inbox has none, since GitHub can't search notifications. */
  search?: string;
  onSearch?(text: string): void;
  /** The project menu, first in the bar. */
  lead?: ReactNode;
  /** Menus after the quick views: Filters (involvement, sort and the rest). */
  menus?: ReactNode;
  /** Quick views: the list's states and who it concerns, as words with counts. */
  views?: ReactNode;
  actions?: ReactNode;
  /** The list's address (filters, sort, search): where it was scrolled is kept per address. */
  address: string;
  /** Its rows are on screen, so a kept position can be restored. */
  ready: boolean;
  /** One status line pinned under the bar (the merge strip). */
  strip?: ReactNode;
  /** A line pinned at the foot of the list (the inbox's keys). */
  footer?: ReactNode;
  children: ReactNode;
}) {
  const { ref, onScroll } = useListScroll(props.kind, props.address, props.ready);
  const header = useSteadyHeader(ref);
  useRememberList(props.kind);
  const label = props.kind === "pulls" ? "Search pull requests" : "Search issues";
  const filtersLabel = {
    inbox: "Inbox filters",
    pulls: "Pull request filters",
    issues: "Issue filters",
  };
  return (
    <div
      ref={ref}
      className={cn("h-full overflow-y-auto", forgeGutter)}
      onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
    >
      <header
        ref={header}
        className={cn(
          "@container/bar sticky top-0 z-[2] bg-background px-(--forge-gutter)",
          toolbarEdge,
        )}
      >
        <div
          role="toolbar"
          aria-label={filtersLabel[props.kind]}
          style={barGrid(!!props.onSearch, !!props.views)}
          className="grid min-w-0 [grid-template-areas:var(--bar-areas)] [grid-template-columns:var(--bar-cols)] items-center gap-x-1 py-2 @min-[1080px]/bar:[grid-template-areas:var(--bar-areas-wide)] @min-[1080px]/bar:[grid-template-columns:var(--bar-cols-wide)]"
        >
          <div className="flex min-w-0 [grid-area:lead]">{props.lead}</div>
          {props.onSearch && (
            <div className="flex min-w-0 [grid-area:search]">
              <SearchBox label={label} value={props.search ?? ""} onValue={props.onSearch} />
            </div>
          )}
          {props.views && (
            // Its own line under the bar while the bar is narrow; on the bar's line once it fits.
            <div className="-ml-2 flex min-w-0 pt-1 [grid-area:views] @min-[1080px]/bar:ml-0 @min-[1080px]/bar:pt-0">
              {props.views}
            </div>
          )}
          <div className="flex min-w-0 items-center [grid-area:menus]">{props.menus}</div>
          <div className="flex shrink-0 items-center justify-end [grid-area:actions]">
            {props.actions}
          </div>
        </div>
        {props.strip}
      </header>
      {props.children}
      {props.footer && (
        <div className="sticky bottom-0 z-[2] border-t border-border bg-background px-(--forge-gutter)">
          {props.footer}
        </div>
      )}
    </div>
  );
}

/**
 * The bar's grid, by what it holds: the project menu, the search (7–12rem), the quick views, the
 * menus, room, then the action. Narrow, the quick views take a second line across the bar.
 */
interface Cell {
  area: string;
  column: string;
}
const cell = (area: string, column: string, on = true): Cell[] => (on ? [{ area, column }] : []);
const areas = (cells: Cell[]) => cells.map((c) => c.area).join(" ");
const columns = (cells: Cell[]) => cells.map((c) => c.column).join(" ");

function barGrid(search: boolean, views: boolean): CSSProperties {
  const row = (inline: boolean) => [
    ...cell("lead", "auto"),
    ...cell("search", "minmax(7rem,12rem)", search),
    ...cell("views", "auto", views && inline),
    ...cell("menus", "auto"),
    ...cell("gap", "minmax(0,1fr)"),
    ...cell("actions", "auto"),
  ];
  const narrow = row(false);
  const wide = row(true);
  const below = views ? ` "${narrow.map(() => "views").join(" ")}"` : "";
  return {
    ["--bar-areas" as string]: `"${areas(narrow)}"${below}`,
    ["--bar-cols" as string]: columns(narrow),
    ["--bar-areas-wide" as string]: `"${areas(wide)}"`,
    ["--bar-cols-wide" as string]: columns(wide),
  };
}

/**
 * The pinned header grows or shrinks (a strip comes or goes) without moving the rows on
 * screen: once scrolled, the scroller follows the change in its height.
 */
function useSteadyHeader(scroller: { current: HTMLDivElement | null }) {
  const header = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const element = header.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    let height = element.offsetHeight;
    const observer = new ResizeObserver(() => {
      const next = element.offsetHeight;
      const list = scroller.current;
      if (list && list.scrollTop > 0 && next !== height) list.scrollTop += next - height;
      height = next;
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [scroller]);
  return header;
}

/** The page's one gutter: 16px in a narrow column, 32px beside it. */
export const forgeGutter = "[--forge-gutter:1rem] sm:[--forge-gutter:2rem]";
