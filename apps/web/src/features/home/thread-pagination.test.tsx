import { workbench } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { openSearchSheet } from "@/test/open-search.ts";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
async function history() {
  const storage = memoryKeyValue();
  storage.setItem(
    "ace.home.organizer",
    JSON.stringify({ baseline: 0, project: null, settledOpen: true }),
  );
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

test("Settled opens on its first ten rows, and Show more reveals the next batch, loading older pages", async () => {
  const app = await history();
  await app.open("/new");
  const lease = app.client.threads();
  try {
    await waitFor(() => expect(lease.store.ids).toHaveLength(20));
    expect(await screen.findByRole("button", { name: "Settled (46)" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Threads" });
    await waitFor(() => expect(settledRows(nav)).toHaveLength(10));
    const fail = vi.spyOn(app.client, "threadsMore").mockRejectedValueOnce(new Error("offline"));
    await userEvent.click(await within(nav).findByRole("button", { name: "Show 25 more" }));
    // A failed page shows what did arrive and offers to try again, without duplicates.
    await within(nav).findByRole("button", { name: "Retry loading more" });
    expect(lease.store.ids).toHaveLength(20);
    expect(settledRows(nav)).toHaveLength(20);
    await userEvent.click(within(nav).getByRole("button", { name: "Retry loading more" }));
    await waitFor(() => expect(lease.store.ids).toHaveLength(46));
    await waitFor(() => expect(settledRows(nav)).toHaveLength(45));
    await userEvent.click(within(nav).getByRole("button", { name: "Show 1 more" }));
    await waitFor(() => expect(settledRows(nav)).toHaveLength(46));
    expect(new Set(lease.store.ids).size).toBe(46);
    expect(within(nav).queryByRole("button", { name: /^Show \d+ more$/ })).toBeNull();
    fail.mockRestore();
  } finally {
    lease.release();
  }
});

test("closing Settled and opening it again starts from its first rows", async () => {
  const app = await history();
  await app.open("/new");
  const nav = await screen.findByRole("navigation", { name: "Threads" });
  await userEvent.click(await within(nav).findByRole("button", { name: "Show 25 more" }));
  await waitFor(() => expect(settledRows(nav)).toHaveLength(35));
  await userEvent.click(within(nav).getByRole("button", { name: "Settled (46)" }));
  await waitFor(() => expect(settledRows(nav)).toHaveLength(0));
  await userEvent.click(within(nav).getByRole("button", { name: "Settled (46)" }));
  await waitFor(() => expect(settledRows(nav)).toHaveLength(10));
  expect(within(nav).getByRole("button", { name: "Show 25 more" })).toBeTruthy();
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
