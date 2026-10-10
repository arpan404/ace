import { act, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

const center = () => document.documentElement.style.getPropertyValue("--toast-pane-center");
const paneWidth = () => document.documentElement.style.getPropertyValue("--toast-pane-width");

afterEach(() => {
  document.documentElement.style.removeProperty("--toast-pane-center");
  document.documentElement.style.removeProperty("--toast-pane-width");
  vi.restoreAllMocks();
});

test("toasts centre over the main pane so they stay clear of an open side panel", async () => {
  let box = new DOMRect(240, 0, 600, 800);
  const fires: (() => void)[] = [];
  const original = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class {
    constructor(changed: ResizeObserverCallback) {
      fires.push(() => changed([], this as unknown as ResizeObserver));
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  const measure = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.tagName === "MAIN" ? box : measure.call(this);
  });
  try {
    const view = await harness().open("/");
    await screen.findByRole("heading", { level: 1, name: "Home" });
    act(() => fires.forEach((fire) => fire()));
    expect(center()).toBe("540px");
    expect(paneWidth()).toBe("600px");

    box = new DOMRect(100, 0, 800, 800);
    act(() => window.dispatchEvent(new Event("resize")));
    expect(center()).toBe("500px");
    expect(paneWidth()).toBe("800px");

    view.unmount();
    expect(center()).toBe("");
    expect(paneWidth()).toBe("");
  } finally {
    globalThis.ResizeObserver = original;
  }
});
