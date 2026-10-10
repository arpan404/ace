import { workbench } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test, vi } from "vitest";
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
test("Show more loads older settled pages and retries a failed page without duplicates", async () => {
  const app = await history();
  await app.open("/new");
  const lease = app.client.threads();
  try {
    await waitFor(() => expect(lease.store.ids).toHaveLength(20));
    expect(await screen.findByRole("button", { name: "Settled 46" })).toBeTruthy();
    const nav = screen.getByRole("navigation", { name: "Threads" });
    const more = await within(nav).findByRole("button", { name: "Show more" });
    const fail = vi.spyOn(app.client, "threadsMore").mockRejectedValueOnce(new Error("offline"));
    await userEvent.click(more);
    await within(nav).findByRole("button", { name: "Retry loading more" });
    expect(lease.store.ids).toHaveLength(20);
    await userEvent.click(within(nav).getByRole("button", { name: "Retry loading more" }));
    await waitFor(() => expect(lease.store.ids).toHaveLength(40));
    await userEvent.click(within(nav).getByRole("button", { name: "Show more" }));
    await waitFor(() => expect(lease.store.ids).toHaveLength(46));
    expect(new Set(lease.store.ids).size).toBe(46);
    expect(within(nav).queryByRole("button", { name: "Show more" })).toBeNull();
    fail.mockRestore();
  } finally {
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
    await userEvent.click(
      within(screen.getByRole("navigation", { name: "App" })).getByRole("button", {
        name: "Search",
      }),
    );
    await userEvent.type(
      await screen.findByRole("combobox", { name: "Search every thread" }),
      "Bump Codex app-server",
    );
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
