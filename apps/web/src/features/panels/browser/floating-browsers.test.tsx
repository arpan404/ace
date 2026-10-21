import { coldStartReplay, seedPanels, workbench } from "@ace/fake-daemon";
import { createMemoryHistory } from "@tanstack/react-router";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { browserVideo } from "@/test/browser-video.ts";
import { harness } from "@/test/harness.tsx";

const togglePanel = () => userEvent.keyboard("{Control>}{Shift>}b{/Shift}{/Control}");
const windows = () => screen.queryAllByRole("region", { name: /^Picture in picture/ });
const livePage = /^Live view of/;

/** A floating window's place, from its own style (jsdom has no layout). */
const box = (window: HTMLElement) => {
  const page = window.querySelector<HTMLElement>("[data-pip-page]");
  return {
    right: parseFloat(window.style.right),
    bottom: parseFloat(window.style.bottom),
    width: parseFloat(window.style.width),
    height: parseFloat(page?.style.height ?? "0") + 28,
  };
};

/** Opens the thread at `path`, looks at its Browser in the panel, then closes the panel. */
async function lookAtBrowser(history: ReturnType<typeof createMemoryHistory>, path: string) {
  const before = screen.queryByRole("heading", { level: 1 })?.textContent;
  act(() => history.push(path));
  const heading = await waitFor(() => {
    const shown = screen.getByRole("heading", { level: 1 });
    if (shown.textContent === before) throw new Error("Still on the last thread");
    return shown;
  });
  await togglePanel();
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  await within(panel).findByRole("img", { name: /^Live view of/ });
  await togglePanel();
  await waitFor(() => expect(screen.queryByRole("region", { name: "Thread panel" })).toBeNull());
  return heading.textContent ?? "";
}

test("agents' pages in several threads float at once, each in its own window, and a click opens that thread's Browser", async () => {
  browserVideo();
  const history = createMemoryHistory({ initialEntries: ["/"] });
  const app = harness({ history });
  app.play(coldStartReplay()).step();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  seedPanels(app.daemon);
  seedPanels(app.daemon, "thread-fan-out");
  await app.open("/");

  const coldStart = await lookAtBrowser(history, "/t/thread-cold-start");
  const fanOut = await lookAtBrowser(history, "/t/thread-fan-out");
  // Both agents keep browsing: both pages stream, each window named for its thread.
  await waitFor(() => expect(windows()).toHaveLength(2));
  const named = (title: string) =>
    windows().find((each) => within(each).queryByText(title) !== null);
  const first = named(coldStart);
  const second = named(fanOut);
  if (!first || !second || first === second) throw new Error("Each window shows its thread");
  expect(await within(first).findByRole("img", { name: livePage })).toBeTruthy();
  expect(await within(second).findByRole("img", { name: livePage })).toBeTruthy();
  // A new window starts beside the open ones, not on top of them.
  const [a, b] = [box(first), box(second)];
  const apart =
    a.right + a.width <= b.right ||
    b.right + b.width <= a.right ||
    a.bottom + a.height <= b.bottom ||
    b.bottom + b.height <= a.bottom;
  expect(apart).toBe(true);

  // From the other thread, a click on the first one's page takes the person to its Browser.
  await userEvent.click(within(first).getByRole("img", { name: livePage }));
  expect(await screen.findByRole("heading", { level: 1, name: coldStart })).toBeTruthy();
  const panel = await screen.findByRole("region", { name: "Thread panel" });
  expect(await within(panel).findByRole("img", { name: livePage })).toBeTruthy();
  // Its window is gone; the other agent's page still floats.
  await waitFor(() => expect(windows()).toHaveLength(1));
  const left = windows()[0] as HTMLElement;
  expect(within(left).getByText(fanOut)).toBeTruthy();
  expect(within(left).getByRole("img", { name: livePage })).toBeTruthy();
});

test("a window closed with × stays away while its thread's agent keeps browsing", async () => {
  browserVideo();
  const history = createMemoryHistory({ initialEntries: ["/"] });
  const app = harness({ history });
  app.play(coldStartReplay()).step();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  seedPanels(app.daemon);
  await app.open("/");
  await lookAtBrowser(history, "/t/thread-cold-start");
  act(() => history.push("/t/thread-fan-out"));
  const floating = await screen.findByRole("region", { name: /^Picture in picture/ });
  await userEvent.click(within(floating).getByRole("button", { name: "Close picture in picture" }));
  await waitFor(() => expect(windows()).toHaveLength(0));
  act(() => app.daemon.browser.agentWorks("thread-cold-start", { agentId: "worker" }));
  act(() => history.push("/t/thread-cold-start"));
  await screen.findByRole("heading", { level: 1 });
  expect(windows()).toHaveLength(0);
});
