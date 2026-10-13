import { workCardScenario } from "@ace/fake-daemon";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";
import { workButton } from "@/test/open-work.ts";

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * A window wide enough for the side card: the thread area measures `width` px. The test window
 * has no layout, so the area's size and its resize notices are stood in at the boundary.
 */
function wideThreadArea(width: number) {
  const fires: (() => void)[] = [];
  vi.stubGlobal(
    "ResizeObserver",
    class implements ResizeObserver {
      constructor(changed: ResizeObserverCallback) {
        fires.push(() => changed([], this));
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  const measure = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.parentElement?.hasAttribute("data-thread-column"))
      return new DOMRect(0, 0, width, 900);
    return measure.call(this);
  });
  return () => act(() => fires.forEach((fire) => fire()));
}

async function openThread() {
  const app = harness();
  const fixture = workCardScenario("changes");
  app.play(fixture).runUntilBlocked();
  await app.open(`/t/${fixture.thread.id}`);
  await screen.findByRole("feed", { name: "Transcript" });
  return app;
}

test("the details shortcut opens the card with focus inside, and Escape hands focus back to the icon", async () => {
  await openThread();
  const icon = await workButton();
  await userEvent.keyboard("{Alt>}{Meta>}o{/Meta}{/Alt}");
  const card = await screen.findByRole("dialog", { name: "Thread details" });
  await waitFor(() => expect(card.contains(document.activeElement)).toBe(true));
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Thread details" })).toBeNull());
  expect(document.activeElement).toBe(icon);
});

test("beside a wide thread area the side card takes focus, and Escape from outside it closes it", async () => {
  const resized = wideThreadArea(1800);
  await openThread();
  resized();
  const icon = await workButton();
  await userEvent.click(icon);
  const card = await screen.findByRole("dialog", { name: "Thread details" });
  await waitFor(() => expect(card.contains(document.activeElement)).toBe(true));
  await within(card).findByRole("region", { name: "Environment" });

  // Escape works from anywhere while the side card is open, not only from inside it.
  act(() => {
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  });
  expect(card.contains(document.activeElement)).toBe(false);
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(card.hidden).toBe(true));
  expect(document.activeElement).toBe(icon);
});

test("Escape inside a menu opened from the side card closes the menu and keeps the card", async () => {
  const resized = wideThreadArea(1800);
  await openThread();
  resized();
  await userEvent.click(await workButton());
  const card = await screen.findByRole("dialog", { name: "Thread details" });
  await userEvent.click(await within(card).findByRole("button", { name: "More git actions" }));
  await screen.findByRole("menu");
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
  expect(card.hidden).toBe(false);
});
