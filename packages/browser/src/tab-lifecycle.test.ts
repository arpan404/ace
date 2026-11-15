import { expect, it } from "vitest";
import { tabTransitions, type TabActivity } from "./tab-lifecycle.ts";

const minute = 60_000;
const tab = (overrides: Partial<TabActivity>): TabActivity => ({
  tabId: "tab",
  lifecycle: "live",
  resting: false,
  viewed: false,
  shown: false,
  busy: false,
  pinned: false,
  lastActiveAt: 0,
  ...overrides,
});

it("an unviewed, undriven tab stops drawing after half a minute idle, and freezes after fifteen minutes", () => {
  expect(tabTransitions([tab({})], 29_000)).toEqual([]);
  expect(tabTransitions([tab({})], 30_000)).toEqual([{ tabId: "tab", to: "resting" }]);
  expect(tabTransitions([tab({ resting: true })], 14 * minute)).toEqual([]);
  expect(tabTransitions([tab({ resting: true })], 15 * minute)).toEqual([
    { tabId: "tab", to: "frozen" },
  ]);
});

it("a tab left idle long enough freezes even if it never rested first", () => {
  expect(tabTransitions([tab({})], 15 * minute)).toEqual([{ tabId: "tab", to: "frozen" }]);
});

it("a tab the person views, an agent drives or a dialog pins never rests or freezes", () => {
  expect(
    tabTransitions(
      [
        tab({ tabId: "viewed", viewed: true }),
        tab({ tabId: "busy", busy: true }),
        tab({ tabId: "pinned", pinned: true }),
      ],
      minute,
    ),
  ).toEqual([]);
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

it("the shown tab nobody watches freezes when idle but is never discarded", () => {
  const shown = tab({ shown: true });
  expect(tabTransitions([shown], 15 * minute)).toEqual([{ tabId: "tab", to: "frozen" }]);
  expect(tabTransitions([{ ...shown, lifecycle: "frozen" }], 3 * 60 * minute)).toEqual([]);
});
