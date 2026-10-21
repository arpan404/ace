import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "@tanstack/react-router";
import { SearchField } from "@/components/search-field.tsx";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs.tsx";
import { toolbarEdge } from "@/components/ui/rules.ts";
import { cn } from "@/lib/cn.ts";
import { useDebouncedValue } from "@/lib/debounced.ts";
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
      className="w-56 min-w-40 shrink"
    />
  );
}

/**
 * A list page's frame: the Pull requests / Issues switch in large type with search, a toolbar of
 * word choices and menus, and the rows, in one scroller. Every band shares one gutter
 * (`--forge-gutter`), so titles, filters and rows start on the same edge. The switch scrolls
 * away with the rows and the toolbar stays pinned; nothing changes size while scrolling, so the
 * rows never jump.
 */
export function ListFrame(props: {
  kind: "pulls" | "issues";
  search: string;
  onSearch(text: string): void;
  /** The toolbar's left: word choices (state, involvement). */
  controls: ReactNode;
  /** The toolbar's right: menus (project, sort, filters). */
  menus?: ReactNode;
  actions?: ReactNode;
  /** The list's address (filters, sort, search): where it was scrolled is kept per address. */
  address: string;
  /** Its rows are on screen, so a kept position can be restored. */
  ready: boolean;
  /** One status line pinned under the toolbar (the merge strip). */
  strip?: ReactNode;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const { ref, onScroll } = useListScroll(props.kind, props.address, props.ready);
  const header = useSteadyHeader(ref);
  const label = props.kind === "pulls" ? "Search pull requests" : "Search issues";
  return (
    <div
      ref={ref}
      className={cn("h-full overflow-y-auto", forgeGutter)}
      onScroll={(event) => onScroll(event.currentTarget.scrollTop)}
    >
      <div className="flex items-center gap-2 px-(--forge-gutter) pt-5 pb-1">
        <Tabs
          value={props.kind}
          onValueChange={(value) =>
            void navigate({ to: value === "issues" ? "/issues" : "/pulls" })
          }
        >
          <TabsList aria-label="Pull requests and issues" className="gap-5">
            <TabsTab value="pulls" className={titleTab}>
              Pull requests
            </TabsTab>
            <TabsTab value="issues" className={titleTab}>
              Issues
            </TabsTab>
          </TabsList>
        </Tabs>
        <span className="flex-1" />
        <SearchBox label={label} value={props.search} onValue={props.onSearch} />
        {props.actions}
      </div>
      <header
        ref={header}
        className={cn("sticky top-0 z-[2] bg-background px-(--forge-gutter)", toolbarEdge)}
      >
        <div
          role="toolbar"
          aria-label={props.kind === "pulls" ? "Pull request filters" : "Issue filters"}
          className="-mx-2 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 py-2"
        >
          {props.controls}
          <span className="flex-1" />
          {props.menus}
        </div>
        {props.strip}
      </header>
      {props.children}
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

/** Pull requests / Issues: words in large type, the current one in the foreground. No fill. */
const titleTab =
  "h-8 rounded-sm px-0 text-lg font-semibold tracking-title text-subtle-foreground hover:not-data-active:bg-transparent hover:text-muted-foreground data-active:bg-transparent data-active:text-foreground";

/** A thin rule between two groups of word choices in a toolbar. */
export function ToolbarRule() {
  return <span aria-hidden className="mx-1.5 h-4 w-px bg-border" />;
}
