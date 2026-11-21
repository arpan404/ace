import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDevicePlacement } from "./use-device-placement.ts";

/*
 * Placing a device tab's native view (ADR 0194) when the desktop's main process answers that it
 * has no view for the tab yet: the placement must not count as done.
 */

type Placement = { tabId: string; visible: boolean };

/** The desktop bridge as the hook reaches it, answering placements from `answers` in turn. */
function bridge(answers: ("shown" | "hidden" | "unavailable")[]) {
  const placed: Placement[] = [];
  Reflect.set(globalThis, "ace", {
    deviceTabs: {
      open: async () => {},
      place: async (request: Placement) => {
        placed.push(request);
        return answers.shift() ?? "shown";
      },
      go: async () => true,
      close: async () => {},
      tunnelPath: async () => {},
      onState: () => () => {},
      onOpenTab: () => () => {},
      onFocusAddress: () => () => {},
    },
  });
  return placed;
}

function area(): HTMLElement {
  const element = document.createElement("div");
  element.getBoundingClientRect = () => new DOMRect(10, 20, 300, 200);
  document.body.append(element);
  return element;
}

// jsdom lays nothing out: the box is the element's stubbed rect, and nothing resizes.
const NoResize = class {
  observe() {}
  disconnect() {}
};
beforeEach(() => vi.stubGlobal("ResizeObserver", NoResize));
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis, "ace");
  document.body.replaceChildren();
});

describe("a device tab's view placement", () => {
  it("is tried again when main had no view for the tab yet, and then shows", async () => {
    const placed = bridge(["unavailable", "shown"]);
    const element = area();
    const { result } = renderHook(() => useDevicePlacement("t1", element, true));
    await waitFor(() => expect(result.current).toBe(true));
    const shown = placed.filter((placement) => placement.visible);
    expect(shown.length).toBeGreaterThanOrEqual(2);
  });

  it("is hidden again when the tab stops showing", async () => {
    const placed = bridge([]);
    const element = area();
    const { result, rerender } = renderHook(
      ({ active }) => useDevicePlacement("t1", element, active),
      {
        initialProps: { active: true },
      },
    );
    await waitFor(() => expect(result.current).toBe(true));
    act(() => rerender({ active: false }));
    expect(result.current).toBe(false);
    expect(placed.at(-1)).toMatchObject({ tabId: "t1", visible: false });
  });
});
