import { useEffect, useLayoutEffect, useState, type RefObject } from "react";
import { fitTabs, sameFit, type TabFit } from "./tab-fit.ts";
import { measureTab } from "./tab-item.tsx";

/** The fade at a clipped edge of the strip (`useEdgeFade`'s width). */
const fade = 16;

const tabElements = (list: HTMLElement) => [
  ...list.querySelectorAll<HTMLElement>(":scope > [data-tab-key]"),
];

/**
 * The strip's layout pass: measures each tab's natural width and the room the strip has (its
 * row less the + and the All tabs menu), then sizes the tabs with `fitTabs`. Runs after every
 * render, whenever the row resizes, and whenever a tab's content changes on its own (a badge
 * with its own live subscription arrives after the tab was measured). jsdom has no layout:
 * there the tabs keep their CSS bounds.
 */
export function useTabFit(
  row: RefObject<HTMLElement | null>,
  list: RefObject<HTMLElement | null>,
  shown: string | undefined,
): TabFit | undefined {
  const [fit, setFit] = useState<TabFit>();
  useLayoutEffect(() => {
    const rowElement = row.current;
    const listElement = list.current;
    if (!rowElement || !listElement) return;
    const measure = () => {
      const siblings = [...rowElement.children].filter(
        (child): child is HTMLElement =>
          child !== listElement &&
          child instanceof HTMLElement &&
          getComputedStyle(child).position !== "absolute",
      );
      const besides = siblings.reduce(
        (sum, child) => sum + (child.offsetWidth > 0 ? child.offsetWidth + 4 : 0),
        0,
      );
      // The list's own 2px of padding each side.
      const available = rowElement.clientWidth - besides - 4;
      if (rowElement.clientWidth <= 0) return;
      const next = fitTabs(
        tabElements(listElement).map((element) => {
          const natural = measureTab(element);
          return { key: element.dataset.tabKey ?? "", natural };
        }),
        shown,
        available,
      );
      setFit((previous) => (sameFit(previous, next) ? previous : next));
    };
    measure();
    // Titles and badges that change without the strip re-rendering (the Changes diff stat
    // loads after the tab first drew) are measured again; the tabs' widths are attributes,
    // which this doesn't watch, so sizing them never loops.
    const mutations =
      typeof MutationObserver === "undefined" ? undefined : new MutationObserver(measure);
    mutations?.observe(listElement, { childList: true, subtree: true, characterData: true });
    const resizes = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(measure);
    resizes?.observe(rowElement);
    return () => {
      mutations?.disconnect();
      resizes?.disconnect();
    };
  });
  return fit;
}

/**
 * Keeps the showing tab inside the strip: when it changes, once a new tab's entrance has played
 * (it is narrower until then), and whenever the strip resizes. Scrolls the list itself, so no
 * outer scroller moves, and clears the edge fade.
 */
export function useRevealShown(list: RefObject<HTMLElement | null>, shown: string | undefined) {
  useEffect(() => {
    const element = list.current;
    if (!element || !shown) return;
    const reveal = () => {
      const tab = tabElements(element).find((each) => each.dataset.tabKey === shown);
      if (!tab) return;
      const box = element.getBoundingClientRect();
      const rect = tab.getBoundingClientRect();
      if (rect.left < box.left + (element.scrollLeft > 0 ? fade : 0))
        element.scrollBy({ left: rect.left - box.left - fade });
      else if (rect.right > box.right - fade && element.scrollWidth > element.clientWidth)
        element.scrollBy({ left: rect.right - box.right + fade });
    };
    reveal();
    element.addEventListener("animationend", reveal);
    element.addEventListener("transitionend", reveal);
    if (typeof ResizeObserver === "undefined")
      return () => {
        element.removeEventListener("animationend", reveal);
        element.removeEventListener("transitionend", reveal);
      };
    const observer = new ResizeObserver(reveal);
    observer.observe(element);
    return () => {
      observer.disconnect();
      element.removeEventListener("animationend", reveal);
      element.removeEventListener("transitionend", reveal);
    };
  }, [list, shown]);
}
