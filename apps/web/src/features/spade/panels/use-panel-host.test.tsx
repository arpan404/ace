import { panelConfirmArmMs } from "@ace/html";
import { act, renderHook } from "@testing-library/react";
import { expect, test } from "vitest";
import { usePanelHost } from "./use-panel-host.ts";

/*
 * An open panel's host (ADR 0200 §5.2, amendment 1): an action the page sends goes on as the
 * page's; one its panel declares `confirm` goes nowhere until the person presses Confirm on ace's
 * own line, and then as theirs. Only a press the browser made from real input counts, once the
 * line has shown long enough; Cancel sends nothing. jsdom can't make a real press, so the test
 * stands in for the browser's word on it at that one boundary, as it does for the clock.
 */

function host() {
  let now = 1000;
  const page: [string, unknown][] = [];
  const person: [string, unknown][] = [];
  const real = new WeakSet<Event>();
  const view = renderHook(() =>
    usePanelHost({
      title: "Watched trips",
      actions: ["stop_watching", "book_fare"],
      confirm: [{ name: "book_fare", label: "Book this fare" }],
      state: undefined,
      theme: { colorScheme: "dark" },
      size: { width: 360, height: 640 },
      onAction: (name, value) => page.push([name, value]),
      onConfirmed: (name, value) => person.push([name, value]),
      now: () => now,
      trusted: (event) => real.has(event),
    }),
  );
  return {
    view,
    page,
    person,
    later: (ms: number) => (now += ms),
    sent: (message: unknown) =>
      act(() => view.result.current.channel.onMessage(JSON.stringify(message))),
    /** A press as the browser makes it from the person's input. */
    realPress: () => {
      const event = new MouseEvent("click");
      real.add(event);
      return event;
    },
  };
}

test("an action without a confirm goes on as the page's, never the person's", () => {
  const h = host();
  h.sent({ type: "ace.panel.action", name: "stop_watching", value: "KTM-DEL" });
  expect(h.page).toEqual([["stop_watching", "KTM-DEL"]]);
  expect(h.person).toEqual([]);
  expect(h.view.result.current.confirm).toBeUndefined();
});

test("an action that needs the person goes only on a real press of Confirm, once it has shown", () => {
  const h = host();
  h.sent({ type: "ace.panel.action", name: "book_fare", value: "KTM-DEL" });
  const line = () => h.view.result.current.confirm;
  expect(line()?.words).toBe("Watched trips asks to send “Book this fare” with KTM-DEL.");
  expect(h.page).toEqual([]);
  // A script's click, however late.
  h.later(panelConfirmArmMs * 10);
  act(() => line()?.press(new MouseEvent("click")));
  expect(h.person).toEqual([]);
  expect(line()).toBeDefined();
  // A real press goes, once, as the person's.
  act(() => line()?.press(h.realPress()));
  expect(h.person).toEqual([["book_fare", "KTM-DEL"]]);
  expect(h.page).toEqual([]);
  expect(line()).toBeUndefined();
});

test("a real press that lands as the line appears is not taken", () => {
  const h = host();
  h.sent({ type: "ace.panel.action", name: "book_fare", value: "KTM-DEL" });
  h.later(panelConfirmArmMs - 1);
  act(() => h.view.result.current.confirm?.press(h.realPress()));
  expect(h.person).toEqual([]);
  h.later(1);
  act(() => h.view.result.current.confirm?.press(h.realPress()));
  expect(h.person).toEqual([["book_fare", "KTM-DEL"]]);
});

test("Cancel sends nothing, and the page can't swap what waits", () => {
  const h = host();
  h.sent({ type: "ace.panel.action", name: "book_fare", value: "KTM-DEL" });
  h.sent({ type: "ace.panel.action", name: "book_fare", value: "LHR-JFK" });
  expect(h.view.result.current.confirm?.words).toContain("KTM-DEL");
  act(() => h.view.result.current.confirm?.cancel());
  expect(h.view.result.current.confirm).toBeUndefined();
  h.later(panelConfirmArmMs);
  expect(h.person).toEqual([]);
  expect(h.page).toEqual([]);
});
