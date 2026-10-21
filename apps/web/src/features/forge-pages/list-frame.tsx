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
      className="w-64 min-w-40 shrink"
    />
  );
}

/**
 * A list page's frame: the Pull requests / Issues tabs, the toolbar and the rows, in one
 * scroller. Once the rows scroll, the tabs fold away and search shrinks to its icon.
 */
export function ListFrame(props: {
  kind: "pulls" | "issues";
  search: string;
  onSearch(text: string): void;
  controls: ReactNode;
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
      className="h-full overflow-y-auto"
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        onScroll(top);
        setCondensed((was) => (was ? top > 0 : top > condenseAt));
      }}
    >
      <header className={cn("sticky top-0 z-[2] bg-background px-4", toolbarEdge)}>
        {!condensed && (
          <div className="flex items-center gap-2 pt-4 pb-2">
            <Tabs
              value={props.kind}
              onValueChange={(value) =>
                void navigate({ to: value === "issues" ? "/issues" : "/pulls" })
              }
            >
              <TabsList aria-label="Pull requests and issues">
                <TabsTab value="pulls" className="h-8 px-3 text-base">
                  Pull requests
                </TabsTab>
                <TabsTab value="issues" className="h-8 px-3 text-base">
                  Issues
                </TabsTab>
              </TabsList>
            </Tabs>
            <span className="flex-1" />
            {props.actions}
          </div>
        )}
        <div
          role="toolbar"
          aria-label={props.kind === "pulls" ? "Pull request filters" : "Issue filters"}
          className="flex min-w-0 flex-wrap items-center gap-1 py-2"
        >
          {props.controls}
          <span className="flex-1" />
          <SearchBox
            label={label}
            value={props.search}
            onValue={props.onSearch}
            condensed={condensed}
          />
          {condensed && props.actions}
        </div>
      </header>
      {props.children}
    </div>
  );
}
