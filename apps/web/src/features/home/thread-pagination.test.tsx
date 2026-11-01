import { workbench } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
import { openSearchSheet } from "@/test/open-search.ts";
import { harness, memoryKeyValue } from "@/test/harness.tsx";
/** 46 settled threads in ace, its only threads, all long past the grace period: only in History. */
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
/** History's rows: each is a link with its thread's title. */
const historyRows = (main: HTMLElement) =>
  within(main).queryAllByRole("link", { name: /^(Finished history \d+|Bump Codex)/ });

test("History pages older settled threads as its end comes into view, and retries a failed page", async () => {
  const app = await history();
  const fail = vi.spyOn(app.client, "threadsMore").mockRejectedValueOnce(new Error("offline"));
  await app.open("/history");
  const lease = app.client.threads();
  try {
    const main = await screen.findByRole("main");
    await within(main).findByRole("heading", { level: 2, name: "History" });
    // The list's end is in view from the start: the first older page fails and offers a retry.
    const retry = await within(main).findByRole("button", {
      name: "Couldn’t load older threads. Retry",
    });
    expect(lease.store.ids).toHaveLength(20);
    expect(historyRows(main)).toHaveLength(20);
    await userEvent.click(retry);
    // No button to press after that: each page arrives as the end shows, until none are left.
    await waitFor(() => expect(lease.store.ids).toHaveLength(46));
    await waitFor(() => expect(historyRows(main)).toHaveLength(46));
    expect(new Set(lease.store.ids).size).toBe(46);
    expect(within(main).queryByRole("button", { name: /Retry|Couldn’t/ })).toBeNull();
    expect(within(main).queryByText("Loading older threads…")).toBeNull();
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
