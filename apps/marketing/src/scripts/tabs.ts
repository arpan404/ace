import { tabChosenEvent, type TabChosen } from "./named-events.ts";
import { firstTab, tabForKey } from "./tab-keys.ts";

/*
 * A tab list over panels (the download page's platforms, the FAQ's topics). A click or the
 * arrow, Home and End keys choose a tab; only the chosen one takes Tab focus, as tab lists do.
 * The root gets `data-enhanced` once the tabs work, so its styles can hide the tabs until then
 * and show every panel without the script.
 *
 * A choice the visitor makes dispatches `ace:tab-chosen` from the root, for analytics.
 *
 * Expects `[role="tab"]` buttons with `data-tab="<name>"` and `[role="tabpanel"]` in the same
 * order.
 */
export function startTabs(root: HTMLElement, wanted?: string): void {
  const tabs = [...root.querySelectorAll<HTMLElement>('[role="tab"]')];
  const panels = [...root.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
  if (tabs.length === 0 || tabs.length !== panels.length) return;

  const choose = (index: number, focus: boolean) => {
    tabs.forEach((tab, at) => {
      tab.setAttribute("aria-selected", at === index ? "true" : "false");
      tab.tabIndex = at === index ? 0 : -1;
    });
    panels.forEach((panel, at) => {
      panel.hidden = at !== index;
    });
    if (focus) tabs[index]?.focus();
  };

  const list = root.querySelector('[role="tablist"]')?.getAttribute("aria-label") ?? "";
  const announce = (index: number) => {
    const detail: TabChosen = { list, tab: tabs[index]?.dataset.tab ?? "" };
    root.dispatchEvent(new CustomEvent(tabChosenEvent, { bubbles: true, detail }));
  };

  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => {
      choose(index, false);
      announce(index);
    });
    tab.addEventListener("keydown", (event) => {
      const next = tabForKey(event.key, index, tabs.length);
      if (next === undefined) return;
      event.preventDefault();
      choose(next, true);
      announce(next);
    });
  });

  const names = tabs.map((tab) => tab.dataset.tab ?? "");
  choose(firstTab(names, wanted), false);
  root.dataset.enhanced = "";
}
