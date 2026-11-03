import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
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
      className="mr-1 w-48 min-w-32 shrink"
    />
  );
}

/**
 * A list page's frame: one pinned bar over the rows, with search and the list's menus (state,
 * filters) on the left and its one action on the right. The page's title is the top bar's, and
 * GitHub's panel moves between Inbox, Pull requests and Issues, so the bar carries no switch of
 * its own. Every band shares one gutter (`--forge-gutter`), so the bar and the rows start on the
 * same edge. Nothing changes size while scrolling, so the rows never jump.
 */
export function ListFrame(props: {
  kind: "inbox" | "pulls" | "issues";
  /** The list's search; the inbox has none, since GitHub can't search notifications. */
  search?: string;
  onSearch?(text: string): void;
  /** The project menu, first in the bar. */
  lead?: ReactNode;
  /** Menus beside the search: the state, then Filters (involvement, sort and the rest). */
  menus?: ReactNode;
  /** Quick views under the bar. */
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
        className={cn("sticky top-0 z-[2] bg-background px-(--forge-gutter)", toolbarEdge)}
      >
        <div className="flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 py-2.5">
          <div
            role="toolbar"
            aria-label={filtersLabel[props.kind]}
            className="flex min-w-0 flex-wrap items-center gap-1"
          >
            {props.lead}
            {props.onSearch && (
              <SearchBox label={label} value={props.search ?? ""} onValue={props.onSearch} />
            )}
            {props.menus}
          </div>
          <span className="flex-1" />
          {props.actions && <div className="ml-1.5 flex items-center">{props.actions}</div>}
        </div>
        {props.views}
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
