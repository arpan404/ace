import { workbench } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { openSearchSheet } from "@/test/open-search.ts";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
/** 46 settled threads in ace, its only threads: ace is a quiet project. */
async function history() {
  const storage = memoryKeyValue();
  storage.setItem("ace.home.organizer", JSON.stringify({ baseline: 0, project: null }));
  const app = harness({ storage });
  const scenario = workbench().find((entry) => entry.thread.id === "thread-bump-codex");
  if (!scenario) throw new Error("Missing done scenario");
  await app.client.start();
  app.play(scenario).runUntilBlocked();
  await app.client.command({ type: "thread.settle", threadId: ThreadId.parse(scenario.thread.id) });
  for (let i = 0; i < 45; i++) {
    const id = `history-${i}`;
    app
      .play({ ...scenario, thread: { ...scenario.thread, id, title: `Finished history ${i}` } })
      .runUntilBlocked();
    await app.client.command({ type: "thread.settle", threadId: ThreadId.parse(id) });
  }
  return app;
}
/** The settled rows the list draws: a settled row is a link with its title. */
const settledRows = (nav: HTMLElement) =>
  within(nav).queryAllByRole("link", { name: /^(Finished history \d+|Bump Codex)/ });

test("a quiet project's Settled list loads older threads as its end comes into view, and retries a failed page", async () => {
  const app = await history();
  const fail = vi.spyOn(app.client, "threadsMore").mockRejectedValueOnce(new Error("offline"));
  await app.open("/new");
  const lease = app.client.threads();
  try {
    const nav = await screen.findByRole("navigation", { name: "Threads" });
    // With nothing open, ace folds under Quiet projects with the daemon's count of its settled.
    await userEvent.click(await within(nav).findByRole("button", { name: /^Quiet projects/ }));
    await userEvent.click(await within(nav).findByRole("button", { name: "ace, 46 settled" }));
    expect(screen.getByRole("tab", { name: "Settled" }).getAttribute("aria-selected")).toBe("true");
    // Every row is in view here, so the end is too: the first page fails and offers a retry.
    const retry = await within(nav).findByRole("button", { name: /Couldn’t load older threads/ });
    expect(lease.store.ids).toHaveLength(20);
    expect(settledRows(nav)).toHaveLength(20);
    await userEvent.click(retry);
    // No button to press after that: each page arrives as the end shows, until none are left.
    await waitFor(() => expect(lease.store.ids).toHaveLength(46));
    await waitFor(() => expect(settledRows(nav)).toHaveLength(46));
    expect(new Set(lease.store.ids).size).toBe(46);
    expect(within(nav).queryByRole("button", { name: /Show|Retry|Couldn’t/ })).toBeNull();
  } finally {
    fail.mockRestore();
    lease.release();
  }
});

test("Search finds an older settled thread outside the window and opens it through a direct subscription", async () => {
  const app = await history();
  await app.open("/new");
  const lease = app.client.threads();
  try {
    await waitFor(() => expect(lease.store.ids).toHaveLength(20));
    expect(lease.store.thread("thread-bump-codex")).toBeUndefined();
    await userEvent.type(await openSearchSheet(), "Bump Codex app-server");
    const result = await screen.findByRole("option", { name: /Bump/ });
    await userEvent.click(result);
    await screen.findByRole("heading", { name: "Bump Codex app-server to 0.48" });
    expect(await screen.findByRole("combobox", { name: "Message" })).toBeTruthy();
    expect(
      await screen.findByText("Bump the Codex app-server to 0.48 and re-record the fixtures."),
    ).toBeTruthy();
    expect(lease.store.ids).toHaveLength(20);
    expect(lease.store.thread("thread-bump-codex")).toBeUndefined();
  } finally {
    lease.release();
  }
});

test("the panel's search lists an older settled thread the list hasn't loaded, and opens it", async () => {
  const app = await history();
  await app.open("/new");
  const lease = app.client.threads();
  try {
    await waitFor(() => expect(lease.store.ids).toHaveLength(20));
    expect(lease.store.thread("thread-bump-codex")).toBeUndefined();
    await userEvent.type(
      screen.getByRole("searchbox", { name: "Search all threads" }),
      "Bump Codex app-server",
    );
    const nav = screen.getByRole("navigation", { name: "Threads" });
    expect(await within(nav).findByRole("heading", { name: /^Settled · 1/ })).toBeTruthy();
    await userEvent.click(
      within(nav).getByRole("link", { name: /^Bump Codex app-server to 0\.48/ }),
    );
    await screen.findByRole("heading", { level: 1, name: "Bump Codex app-server to 0.48" });
  } finally {
    lease.release();
  }
});
