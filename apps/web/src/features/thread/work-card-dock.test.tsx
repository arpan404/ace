import { workCardScenario } from "@ace/fake-daemon";
import { act, screen, within } from "@testing-library/react";
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
 * A thread area measuring `width` px. The test window has no layout, so the area's size and its
 * resize notices are stood in at the boundary.
 */
function threadArea(width: number) {
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

function threadColumn(): HTMLElement {
  const area = document.querySelector("[data-thread-column]");
  if (!(area instanceof HTMLElement)) throw new Error("The thread area is missing");
  return area;
}

function scroller(): HTMLElement {
  const view = document.querySelector("[data-virtual-viewport]");
  if (!(view instanceof HTMLElement)) throw new Error("The transcript scroller is missing");
  return view;
}

async function openThread() {
  const app = harness();
  const fixture = workCardScenario("changes");
  app.play(fixture).runUntilBlocked();
  await app.open(`/t/${fixture.thread.id}`);
  await screen.findByRole("feed", { name: "Transcript" });
}

test("with the card closed the reading column keeps its full width", async () => {
  threadArea(1000);
  await openThread();
  const area = threadColumn();
  expect(area.hasAttribute("data-work-docked")).toBe(false);
  expect(area.style.getPropertyValue("--column")).toBe("");
  expect(area.style.getPropertyValue("--work-reserve")).toBe("");
  expect(area.style.getPropertyValue("--summary-inset")).toBe("");
  expect(area.style.getPropertyValue("padding-right")).toBe("");
  expect(scroller().style.getPropertyValue("padding-right")).toBe("");
});

test("at a mid-width window the open work card floats beside the column without moving it", async () => {
  const resized = threadArea(1000);
  await openThread();
  resized();
  await userEvent.click(await workButton());
  const card = await screen.findByRole("dialog", { name: "Thread details" });
  // The side card, not the header popover.
  expect(card.getAttribute("data-edge")).toBe("right");
  await within(card).findByRole("region", { name: "Workspace" });
  // Opening it moves nothing: no narrowed column, no reserve, no padding on the area or scroller.
  const area = threadColumn();
  expect(area.hasAttribute("data-work-docked")).toBe(false);
  expect(area.style.getPropertyValue("--column")).toBe("");
  expect(area.style.getPropertyValue("--work-reserve")).toBe("");
  expect(area.style.getPropertyValue("--summary-inset")).toBe("");
  expect(area.style.getPropertyValue("padding-right")).toBe("");
  expect(scroller().style.getPropertyValue("padding-right")).toBe("");
});

test("below the minimum the card opens as a popover from the icon", async () => {
  const resized = threadArea(800);
  await openThread();
  resized();
  await userEvent.click(await workButton());
  const card = await screen.findByRole("dialog", { name: "Thread details" });
  await within(card).findByRole("region", { name: "Workspace" });
  // The header popover, not the side card.
  expect(card.hasAttribute("data-edge")).toBe(false);
  const area = threadColumn();
  expect(area.hasAttribute("data-work-docked")).toBe(false);
  expect(area.style.getPropertyValue("--column")).toBe("");
  expect(area.style.getPropertyValue("--work-reserve")).toBe("");
  expect(area.style.getPropertyValue("--summary-inset")).toBe("");
});
