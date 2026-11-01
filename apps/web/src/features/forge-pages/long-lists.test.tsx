import {
  longInbox,
  longIssues,
  longPullRequests,
  seedForgeBrowse,
  workbench,
} from "@ace/fake-daemon";
import { WorkspaceId } from "@ace/protocol";
import { act, configure, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { useScrollLayout } from "@/test/scroll-layout.ts";

configure({ asyncUtilTimeout: 10000 });
useScrollLayout({ viewport: 600, row: 61 });

const total = 2_000;

/** The design's world, its `ace` repository holding 2,000 of each list's items on GitHub. */
function withLongLists() {
  const app = harness();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  seedForgeBrowse(app.daemon, Date.now());
  const now = Date.now();
  app.daemon.workspace.seedPullRequests(longPullRequests(now, total));
  for (const issue of longIssues(now, total))
    app.daemon.workspace.setForgeRead(
      { op: "forge.issue.detail", workspaceId: WorkspaceId.parse("ace"), number: issue.ref.number },
      { resource: "issueDetail", value: issue },
    );
  app.daemon.workspace.inbox.seed(longInbox(now, total));
  return app;
}

/** Press Show more until `name` is a loaded row: the last row End reaches. */
async function loadThrough(list: HTMLElement, name: RegExp) {
  const nav = within(list);
  for (let press = 0; press < 10; press++) {
    focusFirst(list);
    fireEvent.keyDown(document.activeElement ?? list, { key: "End" });
    const reached = await waitFor(() => {
      const active = document.activeElement;
      if (!active || !list.contains(active) || active === list) throw new Error("Not focused yet");
      return active;
    });
    if (name.test(reached.textContent ?? "")) return reached;
    await userEvent.click(nav.getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(list.getAttribute("aria-busy")).toBe("false"));
  }
  throw new Error(`Never reached ${String(name)}`);
}

function focusFirst(list: HTMLElement) {
  const first = list.querySelector<HTMLElement>("[data-view-row]");
  if (!first) throw new Error("No rows");
  act(() => first.focus());
}

/** The list's rows mounted now, of the many loaded. */
const mounted = (list: HTMLElement) => list.querySelectorAll("[data-view-row]").length;

test("pull requests page in by Show more and mount only a window, End reaching the last loaded", async () => {
  const app = withLongLists();
  await app.open("/pulls?project=ace&sort=updated");
  const list = await screen.findByRole("navigation", { name: "Pull requests" });
  await within(list).findByRole("link", { name: /Long list change 0001/ });
  // Five pages (125 rows) are past the point where the list stops mounting every row.
  const last = await loadThrough(list, /Long list change 0125/);
  expect(last.textContent).toMatch(/Long list change 0125/);
  expect(mounted(list)).toBeLessThan(40);
  expect(within(list).queryByRole("link", { name: /Long list change 0001/ })).toBeNull();
  // Home goes back to the first, scrolled into view.
  fireEvent.keyDown(last, { key: "Home" });
  await waitFor(() => expect(document.activeElement?.textContent).toMatch(/Long list change 0001/));
});

test("searching 2,000 pull requests finds one far down the list", async () => {
  const app = withLongLists();
  await app.open("/pulls?project=ace&sort=updated");
  const list = await screen.findByRole("navigation", { name: "Pull requests" });
  await within(list).findByRole("link", { name: /Long list change 0001/ });
  await userEvent.type(screen.getByRole("searchbox", { name: "Search pull requests" }), "1777");
  const found = await screen.findByRole("link", { name: /Long list change 1777/ });
  expect(found).toBeTruthy();
});

test("issues page in by Show more and mount only a window, End reaching the last loaded", async () => {
  const app = withLongLists();
  await app.open("/issues?project=ace");
  const list = await screen.findByRole("navigation", { name: "Issues" });
  await within(list).findByRole("link", { name: /Long list issue 0001/ });
  // The design's own issues sort in among them by age, so five pages end at 0123.
  const last = await loadThrough(list, /Long list issue 0123/);
  expect(last.textContent).toMatch(/Long list issue 0123/);
  expect(mounted(list)).toBeLessThan(40);
});

test("notifications page in by Show more and mount only a window, End reaching the last loaded", async () => {
  const app = withLongLists();
  await app.open("/inbox?project=ace");
  const list = await screen.findByRole("navigation", { name: "Notifications" });
  await within(list).findByText("Long list notification 0001");
  const last = await loadThrough(list, /Long list notification 0150/);
  expect(last.textContent).toMatch(/Long list notification 0150/);
  expect(mounted(list)).toBeLessThan(40);
  expect(within(list).queryByText("Long list notification 0001")).toBeNull();
});
