import { facts, workCardScenario } from "@ace/fake-daemon";
import { createMemoryHistory } from "@tanstack/react-router";
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
 * A thread area measuring `width` px. The test window has no layout, so the area's size and its
 * resize notices are stood in at the boundary.
 */
function threadArea(width: number) {
  let current = width;
  const fires = new Set<() => void>();
  vi.stubGlobal(
    "ResizeObserver",
    class implements ResizeObserver {
      private readonly fire: () => void;
      constructor(changed: ResizeObserverCallback) {
        this.fire = () => changed([], this);
        fires.add(this.fire);
      }
      observe() {}
      unobserve() {}
      disconnect() {
        fires.delete(this.fire);
      }
    },
  );
  const measure = HTMLElement.prototype.getBoundingClientRect;
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (this.parentElement?.hasAttribute("data-thread-column"))
      return new DOMRect(0, 0, current, 900);
    return measure.call(this);
  });
  return (next?: number) => {
    if (next !== undefined) current = next;
    act(() => fires.forEach((fire) => fire()));
  };
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

test("at a mid-width window the open work card docks beside a narrower reading column", async () => {
  const resized = threadArea(1000);
  await openThread();
  resized();
  await userEvent.click(await workButton());
  const card = await screen.findByRole("dialog", { name: "Thread details" });
  // The side card, not the header popover.
  expect(card.getAttribute("data-edge")).toBe("right");
  await within(card).findByRole("region", { name: "Workspace" });
  const area = threadColumn();
  expect(area.getAttribute("data-work-docked")).toBe("");
  // 1000px leaves 672px for the column after the 280px card and its 48px of gaps.
  expect(area.style.getPropertyValue("--column")).toBe("672px");
  // The reserve lives in the content column's inset variables, never as padding on the area
  // or the scroller: the scroller keeps its full width and its scrollbar stays at the far
  // right edge, with the card floating over the gutter above it.
  expect(area.style.getPropertyValue("--work-reserve")).toBe("304px");
  expect(area.style.getPropertyValue("--summary-inset")).toBe("304px");
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
  // The header popover, not the docked side card.
  expect(card.hasAttribute("data-edge")).toBe(false);
  const area = threadColumn();
  expect(area.hasAttribute("data-work-docked")).toBe(false);
  expect(area.style.getPropertyValue("--column")).toBe("");
  expect(area.style.getPropertyValue("--work-reserve")).toBe("");
  expect(area.style.getPropertyValue("--summary-inset")).toBe("");
});

test("opening the card on the main thread shows it docked on a thread_start child on first render, and closing on the child closes it on the main thread", async () => {
  const resized = threadArea(1000);
  const fixture = workCardScenario("changes");
  const history = createMemoryHistory({ initialEntries: [`/t/${fixture.thread.id}`] });
  const app = harness({ history });
  app.play(fixture).runUntilBlocked();
  app.daemon.createThread({
    id: "started-child",
    workspaceId: fixture.thread.workspaceId,
    title: "Started child",
    provider: "codex",
    startedBy: fixture.thread.id,
    hasSentMessage: true,
  });
  await app.open(`/t/${fixture.thread.id}`);
  await screen.findByRole("feed", { name: "Transcript" });
  resized();

  // Open the card on the main thread.
  await userEvent.click(await workButton());
  const mainCard = await screen.findByRole("dialog", { name: "Thread details" });
  expect(mainCard.getAttribute("data-edge")).toBe("right");

  // Navigate to the thread_start child: the card must be docked on its very first render
  // with no closed frame and no slide-in toggle animation.
  await act(async () => {
    history.push("/t/started-child");
  });
  const childCard = screen.getByRole("dialog", { name: "Thread details" });
  expect(childCard.getAttribute("data-edge")).toBe("right");
  expect(childCard.className).not.toContain("fx-panel-in");
  expect(threadColumn().hasAttribute("data-work-docked")).toBe(true);

  // Closing the card on the child closes it on the main thread too.
  await userEvent.click(await workButton());
  expect(threadColumn().hasAttribute("data-work-docked")).toBe(false);
  await act(async () => {
    history.push(`/t/${fixture.thread.id}`);
  });
  expect(threadColumn().hasAttribute("data-work-docked")).toBe(false);
  expect(screen.queryByRole("dialog", { name: "Thread details" })).toBeNull();
});

test("a provider subagent screen uses its thread's tree root and docks on first render", async () => {
  const resized = threadArea(1000);
  const fixture = workCardScenario("changes");
  const history = createMemoryHistory({ initialEntries: [`/t/${fixture.thread.id}`] });
  const app = harness({ history });
  app.play(fixture).runUntilBlocked();
  app.daemon.createThread({
    id: "started-child",
    workspaceId: fixture.thread.workspaceId,
    title: "Started child",
    provider: "codex",
    startedBy: fixture.thread.id,
    hasSentMessage: true,
  });
  app.daemon.apply("started-child", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Check the patch"),
    facts.tool("root", "spawn-1", {
      kind: "agent.spawn",
      title: "Review helper",
      detail: { kind: "agent.spawn", childAgent: "sub-1" },
    }),
    facts.subagent("codex", "sub-1", "Review helper", "spawn-1"),
    facts.turn("sub-1", "spawn"),
    facts.message("sub-1", "ans", "assistant", "Checking", false),
  ]);
  await app.open(`/t/${fixture.thread.id}`);
  await screen.findByRole("feed", { name: "Transcript" });
  resized();

  // Open the card on the main thread.
  await userEvent.click(await workButton());
  await screen.findByRole("dialog", { name: "Thread details" });

  // Open the child thread, then its provider subagent screen.
  await act(async () => {
    history.push("/t/started-child");
  });
  const childFeed = await screen.findByRole("feed", { name: "Transcript" });
  await userEvent.click(
    await within(childFeed).findByRole("link", { name: "Open Review helper, Running" }),
  );
  const subCard = await screen.findByRole("dialog", { name: "Thread details" });
  expect(subCard.getAttribute("data-edge")).toBe("right");
  expect(subCard.className).not.toContain("fx-panel-in");
  expect(threadColumn().hasAttribute("data-work-docked")).toBe(true);

  // Closing the card on the subagent closes it on the main thread.
  await userEvent.click(await workButton());
  expect(threadColumn().hasAttribute("data-work-docked")).toBe(false);
  await act(async () => {
    history.push(`/t/${fixture.thread.id}`);
  });
  expect(screen.queryByRole("dialog", { name: "Thread details" })).toBeNull();
});

test("a remembered-open card on a narrow area shows the Work icon pressed with no popover, opens on click, and docks when widened", async () => {
  const resized = threadArea(1000);
  const fixture = workCardScenario("changes");
  const history = createMemoryHistory({ initialEntries: [`/t/${fixture.thread.id}`] });
  const app = harness({ history });
  app.play(fixture).runUntilBlocked();
  app.daemon.createThread({
    id: "started-child",
    workspaceId: fixture.thread.workspaceId,
    title: "Started child",
    provider: "codex",
    startedBy: fixture.thread.id,
    hasSentMessage: true,
  });
  await app.open(`/t/${fixture.thread.id}`);
  await screen.findByRole("feed", { name: "Transcript" });
  resized();

  // Open the card while wide, then narrow the area below the docking floor.
  await userEvent.click(await workButton());
  expect((await screen.findByRole("dialog", { name: "Thread details" })).getAttribute("data-edge")).toBe(
    "right",
  );
  resized(800);

  // Navigate to a child screen while narrow: no popover auto-opens, Work icon stays pressed.
  await act(async () => {
    history.push("/t/started-child");
  });
  await screen.findByRole("feed", { name: "Transcript" });
  const button = await workButton();
  expect(screen.queryByRole("dialog", { name: "Thread details" })).toBeNull();
  expect(button.getAttribute("aria-pressed")).toBe("true");
  expect(button.getAttribute("data-state")).toBe("active");
  expect(button.getAttribute("aria-expanded")).toBe("false");

  // One click opens the popover as today.
  await userEvent.click(button);
  const popover = await screen.findByRole("dialog", { name: "Thread details" });
  expect(popover.hasAttribute("data-edge")).toBe(false);
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(button.getAttribute("aria-pressed")).toBe("true");

  // Widening while the popover is open docks the card beside the column.
  resized(1000);
  const docked = await screen.findByRole("dialog", { name: "Thread details" });
  expect(docked.getAttribute("data-edge")).toBe("right");
  expect(threadColumn().hasAttribute("data-work-docked")).toBe(true);

  // Narrow again (squeezed out, remembered open), then widen without clicking: docks by itself.
  resized(800);
  expect(threadColumn().hasAttribute("data-work-docked")).toBe(false);
  await waitFor(() => expect(screen.queryByRole("dialog", { name: "Thread details" })).toBeNull());
  expect((await workButton()).getAttribute("aria-pressed")).toBe("true");
  expect((await workButton()).getAttribute("aria-expanded")).toBe("false");
  resized(1000);
  const redocked = await screen.findByRole("dialog", { name: "Thread details" });
  expect(redocked.getAttribute("data-edge")).toBe("right");
  expect(threadColumn().hasAttribute("data-work-docked")).toBe(true);
});
