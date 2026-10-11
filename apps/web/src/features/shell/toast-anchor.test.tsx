import { coldStartReplay, seedPanels } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

const center = () => document.documentElement.style.getPropertyValue("--toast-pane-center");
const paneWidth = () => document.documentElement.style.getPropertyValue("--toast-pane-width");

afterEach(() => {
  document.documentElement.style.removeProperty("--toast-pane-center");
  document.documentElement.style.removeProperty("--toast-pane-width");
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function geometry(main: () => DOMRect, sidebar = () => new DOMRect()) {
  const fires: (() => void)[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class implements ResizeObserver {
      private active = true;
      constructor(changed: ResizeObserverCallback) {
        fires.push(() => {
          if (this.active) changed([], this);
        });
      }
      observe() {}
      unobserve() {}
      disconnect() {
        this.active = false;
      }
    },
  );
  const measure = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.tagName === "MAIN") return this.closest("[hidden]") ? new DOMRect() : main();
    if (this.matches('[data-slot="sidebar-inner"]')) return sidebar();
    return measure.call(this);
  });
  return () => act(() => fires.forEach((fire) => fire()));
}

test("toasts centre over the main pane so they stay clear of an open side panel", async () => {
  let box = new DOMRect(240, 0, 600, 800);
  const resized = geometry(() => box);
  const view = await harness().open("/");
  await screen.findByRole("heading", { level: 1, name: "Home" });
  resized();
  expect(center()).toBe("540px");
  expect(paneWidth()).toBe("600px");

  box = new DOMRect(100, 0, 800, 800);
  act(() => window.dispatchEvent(new Event("resize")));
  expect(center()).toBe("500px");
  expect(paneWidth()).toBe("800px");

  view.unmount();
  expect(center()).toBe("");
  expect(paneWidth()).toBe("");
});

test("full view anchors to the visible sidebar, uses the viewport while it is hidden, and restores the pane on return", async () => {
  const resized = geometry(
    () => new DOMRect(280, 0, 640, 800),
    () => new DOMRect(0, 0, 280, 800),
  );
  const app = harness();
  app.play(coldStartReplay()).runThrough("turn-2");
  seedPanels(app.daemon);
  const view = await app.open("/t/thread-cold-start");
  await screen.findByRole("heading", { level: 1, name: "Cap cold-start replay at 200 events" });
  await userEvent.click(screen.getByRole("button", { name: "Right panel" }));
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  resized();
  expect(center()).toBe("600px");
  await userEvent.click(within(panel).getByRole("button", { name: "Full view" }));
  expect(screen.queryByRole("main")).toBeNull();
  resized();
  expect(center()).toBe("140px");
  expect(paneWidth()).toBe("280px");

  // Collapsing the sidebar changes its visibility rather than the hidden main's size.
  await userEvent.click(screen.getByRole("button", { name: "Hide sidebar" }));
  await waitFor(() => expect(center()).toBe("226px"));
  expect(paneWidth()).toBe("420px");
  expect(document.documentElement.style.getPropertyValue("--toast-pane-bottom")).toBe("16px");
  await userEvent.click(screen.getByRole("button", { name: "Show sidebar" }));
  await waitFor(() => expect(center()).toBe("140px"));

  await userEvent.click(within(panel).getByRole("button", { name: "Exit full view" }));
  expect(await screen.findByRole("main")).toBeTruthy();
  resized();
  expect(center()).toBe("600px");
  expect(paneWidth()).toBe("640px");
  view.unmount();
  expect(center()).toBe("");
  expect(paneWidth()).toBe("");
});
