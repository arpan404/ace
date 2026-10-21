import { useEffect, useRef, useState, type ReactNode } from "react";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { useNavigate } from "@tanstack/react-router";
import { SearchField } from "@/components/search-field.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs.tsx";
import { toolbarEdge } from "@/components/ui/rules.ts";
import { cn } from "@/lib/cn.ts";
import { useDebouncedValue } from "@/lib/debounced.ts";
import { useListScroll } from "./list-scroll.ts";

/** GitHub's search allows 30 requests a minute: let typing settle before asking. */
const settleMs = 300;
/** Scrolled this far, the header folds to one slim bar. */
const condenseAt = 24;

function SearchBox(props: {
  label: string;
  value: string;
  onValue(value: string): void;
  condensed: boolean;
}) {
  const [text, setText] = useState(props.value);
  const [expanded, setExpanded] = useState(false);
  const input = useRef<HTMLInputElement | null>(null);
  const settled = useDebouncedValue(text, settleMs);
  const onValue = props.onValue;
  useEffect(() => {
    if (settled.trim() !== props.value.trim()) onValue(settled);
  }, [settled, props.value, onValue]);
  // ⌘F searches the list, the way it finds on the page in a browser.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key.toLowerCase() !== "f" || !(event.metaKey || event.ctrlKey) || event.shiftKey)
        return;
      event.preventDefault();
      setExpanded(true);
      requestAnimationFrame(() => input.current?.focus());
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  if (props.condensed && !expanded && !text)
    return (
      <IconButton
        size="sm"
        icon={MagnifyingGlassIcon}
        label={props.label}
        onClick={() => {
          setExpanded(true);
          requestAnimationFrame(() => input.current?.focus());
        }}
      />
    );
  return (
    <SearchField
      ref={input}
      label={props.label}
      placeholder="Search"
      value={text}
      onValueChange={setText}
      onBlur={() => setExpanded(false)}
      className="w-56 min-w-40 shrink"
    />
  );
}

/**
 * A list page's frame: the Pull requests / Issues switch in large type with search, a toolbar of
 * word choices and menus, and the rows, in one scroller. Every band shares one gutter
 * (`--forge-gutter`), so titles, filters and rows start on the same edge. Once the rows scroll,
 * the switch folds away and search shrinks to its icon.
 */
export function ListFrame(props: {
  kind: "pulls" | "issues";
  search: string;
  onSearch(text: string): void;
  /** The toolbar's left: word choices (state, involvement). */
  controls: ReactNode;
  /** The toolbar's right, before search: menus (project, sort, filters). */
  menus?: ReactNode;
  actions?: ReactNode;
  /** The list's address (filters, sort, search): where it was scrolled is kept per address. */
  address: string;
  /** Its rows are on screen, so a kept position can be restored. */
  ready: boolean;
  children: ReactNode;
}) {
  const navigate = useNavigate();
  const [condensed, setCondensed] = useState(false);
  const { ref, onScroll } = useListScroll(props.kind, props.address, props.ready);
  const label = props.kind === "pulls" ? "Search pull requests" : "Search issues";
  return (
    <div
      ref={ref}
      className={cn("h-full overflow-y-auto", forgeGutter)}
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        onScroll(top);
        setCondensed((was) => (was ? top > 0 : top > condenseAt));
      }}
    >
      <header className={cn("sticky top-0 z-[2] bg-background px-(--forge-gutter)", toolbarEdge)}>
        {!condensed && (
          <div className="flex items-center gap-2 pt-5 pb-1">
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
            <SearchBox
              label={label}
              value={props.search}
              onValue={props.onSearch}
              condensed={false}
            />
            {props.actions}
          </div>
        )}
        <div
          role="toolbar"
          aria-label={props.kind === "pulls" ? "Pull request filters" : "Issue filters"}
          className="-mx-2 flex min-w-0 flex-wrap items-center gap-x-1 gap-y-1 py-2"
        >
          {props.controls}
          <span className="flex-1" />
          {props.menus}
          {condensed && (
            <SearchBox label={label} value={props.search} onValue={props.onSearch} condensed />
          )}
          {condensed && props.actions}
        </div>
      </header>
      {props.children}
    </div>
  );
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
