import {
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
  type UIEvent,
} from "react";
import { Tabs, TabsList, TabsTab, TabsPanel } from "@/components/ui/tabs.tsx";
import { cn } from "@/lib/cn.ts";

export type PrTab = "summary" | "timeline" | "code" | "checks";

const order: PrTab[] = ["summary", "timeline", "code", "checks"];
const names: Record<PrTab, string> = {
  summary: "Summary",
  timeline: "Timeline",
  code: "Code",
  checks: "Checks",
};

/**
 * Summary · Timeline · Code · Checks as words: the current one on the flat selected fill, no
 * shadow. Focus shows only from the keyboard, as the quiet inset ring rows use.
 */
export const wordTab =
  "h-7 rounded-md px-2 text-ui font-normal focus-ring-inset hover:not-data-active:bg-hover data-active:bg-active data-active:font-medium";

/**
 * The tab bar: Summary · Timeline · Code · Checks as words with a quiet count each, and the
 * active tab's context at its right end. In a panel each tab body is its own scroller. On a page
 * the whole page scrolls as one inside the page's column: the header scrolls away, the bar pins
 * to the top, Summary and Timeline grow with their content, and Code fills the space under the
 * bar with its own scrollers. Switching tabs brings the bar back to the top, so the new tab
 * starts at its start. `pinned` shows only while the bar is pinned, once the header (which has
 * its own copy of those actions) has scrolled away.
 */
export function PrTabs(props: {
  available?: Partial<Record<PrTab, boolean>>;
  tab: PrTab;
  onTab(tab: string): void;
  context: Record<PrTab, ReactNode>;
  /** Shown at the bar's end only while the bar is pinned and the header is out of view. */
  pinned?: Partial<Record<PrTab, ReactNode>> | undefined;
  panels: Record<PrTab, ReactNode>;
  /** How many each tab holds: comments, changed files, checks. */
  counts: Partial<Record<PrTab, number>>;
  onScroll(tab: PrTab, top: number): void;
  /** On a page of its own: the page's column, which every tab (Code too) keeps to. */
  readable?: string | undefined;
}) {
  const visible = order.filter((tab) => props.available?.[tab] !== false);
  const selected = visible.includes(props.tab) ? props.tab : "summary";
  const page = props.readable !== undefined;
  const bar = useRef<HTMLDivElement | null>(null);
  const codeHeight = usePageCodeHeight(bar, page);
  const stuck = useBarPinned(bar, page);
  // A reading tab starts at its top; Code, which scrolls inside itself, takes the whole page.
  const toBar = (tab: string) =>
    requestAnimationFrame(() => {
      const element = bar.current;
      const scroller = element?.closest<HTMLElement>("[data-pr-scroller]");
      if (!element || !scroller) return;
      const top =
        element.getBoundingClientRect().top -
        scroller.getBoundingClientRect().top +
        scroller.scrollTop;
      if (tab === "code" || scroller.scrollTop > top) scroller.scrollTop = top;
    });
  const pinned = page && stuck ? props.pinned?.[selected] : undefined;
  return (
    <Tabs
      value={selected}
      onValueChange={(value) => {
        if (typeof value !== "string" || !visible.some((tab) => tab === value)) return;
        props.onTab(value);
        if (page) toBar(value);
      }}
      className={page ? "flex flex-col" : "flex min-h-0 flex-1 flex-col"}
    >
      <div
        ref={bar}
        className={cn(
          "shrink-0 border-t border-border py-2",
          page && "sticky top-0 z-[3] border-b bg-panel",
        )}
      >
        <div
          className={cn(
            "flex items-center justify-between gap-2 px-[var(--forge-gutter,1rem)]",
            props.readable,
          )}
        >
          <TabsList aria-label="Pull request detail" className="-ml-2">
            {visible.map((tab) => (
              <TabsTab key={tab} value={tab} className={wordTab}>
                {names[tab]}
                {!!props.counts[tab] && (
                  <span
                    aria-hidden
                    className="ml-1 font-normal text-subtle-foreground tabular-nums"
                  >
                    {props.counts[tab]}
                  </span>
                )}
              </TabsTab>
            ))}
          </TabsList>
          <div className="flex min-w-0 items-center gap-2">
            {props.context[selected]}
            {pinned}
          </div>
        </div>
      </div>
      {visible.map((tab) => (
        <TabsPanel
          key={tab}
          value={tab}
          className={cn(
            !page && "overflow-auto border-t border-border",
            page && tab === "code" && "flex-none overflow-hidden",
            page && tab !== "code" && "flex-none",
          )}
          style={page && tab === "code" ? { height: codeHeight } : undefined}
          onScroll={
            page
              ? undefined
              : (e: UIEvent<HTMLDivElement>) => props.onScroll(tab, e.currentTarget.scrollTop)
          }
        >
          {page ? (
            <div
              className={cn(
                props.readable,
                // A jump to a part of the tab (Blocking the merge, Reviewers) clears the pinned bar.
                "[&_[id]]:scroll-mt-16",
                // Code's own bars pad by 0.75rem; this lines their words up with the tabs'.
                tab === "code" && "h-full px-[max(0rem,calc(var(--forge-gutter,1rem)-0.75rem))]",
              )}
            >
              {props.panels[tab]}
            </div>
          ) : (
            props.panels[tab]
          )}
        </TabsPanel>
      ))}
    </Tabs>
  );
}

/** On a page, the Code tab's height: the page's scroller less the pinned tab bar. */
function usePageCodeHeight(bar: RefObject<HTMLDivElement | null>, page: boolean) {
  const [height, setHeight] = useState<number | undefined>(undefined);
  useLayoutEffect(() => {
    const element = bar.current;
    const scroller = element?.closest<HTMLElement>("[data-pr-scroller]");
    if (!page || !element || !scroller) return;
    const measure = () => setHeight(Math.max(0, scroller.clientHeight - element.offsetHeight));
    measure();
    // Without ResizeObserver (old engines, tests) the first measure stands.
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(scroller);
    observer.observe(element);
    return () => observer.disconnect();
  }, [bar, page]);
  return height;
}

/** On a page, whether the bar sits pinned at the scroller's top with the header scrolled away. */
function useBarPinned(bar: RefObject<HTMLDivElement | null>, page: boolean) {
  const [pinned, setPinned] = useState(false);
  useLayoutEffect(() => {
    const element = bar.current;
    const scroller = element?.closest<HTMLElement>("[data-pr-scroller]");
    if (!page || !element || !scroller) return;
    const measure = () =>
      setPinned(
        scroller.scrollTop > 0 &&
          element.getBoundingClientRect().top - scroller.getBoundingClientRect().top < 1,
      );
    measure();
    scroller.addEventListener("scroll", measure, { passive: true });
    return () => scroller.removeEventListener("scroll", measure);
  }, [bar, page]);
  return pinned;
}
