import { facts, replayCursor, workCardScenario } from "@ace/fake-daemon";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { harness } from "@/test/harness.tsx";

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test("a script reuses an agent shell whose command arrives after the task", async () => {
  const app = harness();
  app.play(replayCursor()).runThrough("delegated");
  const threadId = "thread-replay-cursor";
  app.daemon.apply(threadId, [
    facts.tool("root", "late-shell", {
      kind: "shell",
      title: "Starting relay",
      detail: { kind: "shell", command: "" },
    }),
    {
      type: "background.started",
      agent: "root",
      task: "late-shell",
      item: "late-shell",
      kind: "shell",
      title: "Starting relay",
      ambient: true,
      stoppable: true,
    },
  ]);
  await app.open(`/t/${threadId}`);
  await userEvent.click(await screen.findByRole("button", { name: /^Work card/ }));
  const card = screen.getByRole("complementary", { name: "Work card" });
  await userEvent.click(within(card).getByRole("button", { name: "Project actions" }));
  const script = await screen.findByRole("menuitem", { name: "Run bun run dev:relay" });
  act(() =>
    app.daemon.apply(threadId, [
      facts.tool("root", "late-shell", {
        kind: "shell",
        title: "Starting relay",
        detail: { kind: "shell", command: "bun run dev:relay" },
      }),
    ]),
  );
  await within(card).findByRole("button", { name: /^Show bun run dev:relay:/ });
  await userEvent.click(script);
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(await within(panel).findByText("Agent shell")).toBeTruthy();
  expect(app.daemon.terminals.list(threadId)).toEqual([]);
});

test("expanded completed agents and their scroll position survive a remount", async () => {
  const resized = new Map<ResizeObserver, () => void>();
  // jsdom has no layout notifications. Deliver the card's real resize callback after its
  // asynchronously loaded agent rows give it enough height for the saved position.
  vi.stubGlobal(
    "ResizeObserver",
    class implements ResizeObserver {
      private callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe(target: Element) {
        if (target.hasAttribute("data-work-card-scroll"))
          resized.set(this, () => this.callback([], this));
      }
      unobserve() {}
      disconnect() {
        resized.delete(this);
      }
    },
  );
  vi.spyOn(HTMLElement.prototype, "scrollHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    if (!this.hasAttribute("data-work-card-scroll")) return 0;
    return (
      (this.querySelector('section[aria-label="Agents"]')?.querySelectorAll("button").length ?? 0) *
        40 +
      200
    );
  });
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.hasAttribute("data-work-card-scroll") ? 100 : 0;
  });
  const app = harness();
  const scenario = workCardScenario("many-agents");
  app.play(scenario).runUntilBlocked();
  const view = await app.open(`/t/${scenario.thread.id}`);
  await userEvent.click(await screen.findByRole("button", { name: /^Work card/ }));
  const card = screen.getByRole("complementary", { name: "Work card" });
  await userEvent.click(within(card).getByRole("button", { name: "Previous agents (10)" }));
  const scroll = card.querySelector<HTMLElement>("[data-work-card-scroll]");
  if (!scroll) throw new Error("Missing card scroll region");
  scroll.scrollTop = 450;
  fireEvent.scroll(scroll);
  fireEvent(scroll, new Event("scrollend"));
  view.unmount();
  await app.open(`/t/${scenario.thread.id}`);
  const restored = await screen.findByRole("complementary", { name: "Work card" });
  expect(
    within(restored)
      .getByRole("button", { name: "Previous agents (10)" })
      .getAttribute("aria-expanded"),
  ).toBe("true");
  act(() => resized.forEach((notify) => notify()));
  expect(restored.querySelector<HTMLElement>("[data-work-card-scroll]")?.scrollTop).toBe(450);
});

test("cached work is marked last seen until the connection is fresh again", async () => {
  const app = harness();
  const scenario = workCardScenario("changes");
  app.play(scenario).runUntilBlocked();
  await app.open(`/t/${scenario.thread.id}`);
  const toggle = await screen.findByRole("button", { name: /^Work card/ });
  expect(toggle.getAttribute("aria-label")).toContain("2 agents running");
  act(() => {
    app.daemon.refuseConnections(true);
    app.daemon.disconnectAll();
  });
  await waitFor(() => expect(app.client.state).not.toBe("ready"));
  await waitFor(() => expect(toggle.getAttribute("aria-label")).toMatch(/Last seen.*2 agents/));
  expect(toggle.getAttribute("aria-label")).not.toContain("agents running");
  expect(toggle.getAttribute("aria-label")).toMatch(/Offline|Reconnecting/);
  act(() => app.daemon.refuseConnections(false));
  await waitFor(() => expect(app.client.state).toBe("ready"));
  await waitFor(() => expect(toggle.getAttribute("aria-label")).toContain("2 agents running"));
  expect(toggle.getAttribute("aria-label")).not.toContain("Last seen");
});
