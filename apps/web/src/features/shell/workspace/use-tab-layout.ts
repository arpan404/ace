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
 * render (titles change) and whenever the row resizes. jsdom has no layout: there the tabs keep
 * their CSS bounds.
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
          const { natural, least } = measureTab(element);
          const tool = element.dataset.tabTool === "true";
          return { key: element.dataset.tabKey ?? "", natural, least, tool };
        }),
        shown,
        available,
      );
      setFit((previous) => (sameFit(previous, next) ? previous : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(rowElement);
    return () => observer.disconnect();
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
