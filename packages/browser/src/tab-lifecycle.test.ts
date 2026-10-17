import { expect, it } from "vitest";
import { tabTransitions, type TabActivity } from "./tab-lifecycle.ts";

const minute = 60_000;
const tab = (overrides: Partial<TabActivity>): TabActivity => ({
  tabId: "tab",
  lifecycle: "live",
  viewed: false,
  busy: false,
  pinned: false,
  lastActiveAt: 0,
  ...overrides,
});

it("an unviewed, undriven tab freezes after fifteen idle minutes", () => {
  expect(tabTransitions([tab({})], 14 * minute)).toEqual([]);
  expect(tabTransitions([tab({})], 15 * minute)).toEqual([{ tabId: "tab", to: "frozen" }]);
});

it("a tab the person views, an agent drives or a dialog pins never freezes", () => {
  const idle = 3 * 60 * minute;
  expect(
    tabTransitions(
      [
        tab({ tabId: "viewed", viewed: true }),
        tab({ tabId: "busy", busy: true }),
        tab({ tabId: "pinned", pinned: true }),
      ],
      idle,
    ),
  ).toEqual([]);
});

it("an idle tab is due for discard after two hours, and a frozen one is not frozen again", () => {
  expect(
    tabTransitions(
      [
        tab({ tabId: "old", lifecycle: "frozen" }),
        tab({ tabId: "recent", lifecycle: "frozen", lastActiveAt: 60 * minute }),
      ],
      2 * 60 * minute,
    ),
  ).toEqual([{ tabId: "old", to: "discarded" }]);
});
