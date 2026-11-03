import { workbench } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10000 });

const hour = 3_600_000;
const threads = () => screen.getByRole("navigation", { name: "Threads" });
const alarm = "Back from snooze: its time came";

test("a snooze that ends by itself brings the row back with an alarm saying why, until the thread is opened", async () => {
  let now = Date.parse("2026-11-03T12:00:00Z");
  const app = harness({ clock: () => now, uiClock: () => now });
  await app.client.start();
  for (const scenario of workbench()) app.play(scenario).runUntilBlocked();
  // The workbench's finished Codex bump, kept in the Inbox (its merged PR would settle it).
  const id = ThreadId.parse("thread-bump-codex");
  await app.client.command({ type: "thread.unsettle", threadId: id });
  const view = app.daemon.snapshot({ kind: "threads" });
  const done = view?.kind === "threads" ? view.threads[id] : undefined;
  if (done?.status.state !== "done" || done.settledAt)
    throw new Error("Expected it done, in the Inbox");
  const row = () => within(threads()).findByRole("link", { name: new RegExp(`^${done.title}`) });
  await app.client.command({
    type: "thread.snooze",
    threadId: id,
    until: now + hour,
  });
  await app.open("/");
  await waitFor(() =>
    expect(
      within(threads()).queryByRole("link", { name: new RegExp(`^${done.title}`) }),
    ).toBeNull(),
  );

  now += 2 * hour;
  app.daemon.sweep();
  const back = await row();
  expect(await within(back).findByRole("img", { name: alarm })).toBeTruthy();
  expect(within(back).getByText("snooze ended")).toBeTruthy();

  // Opened, the thread ends with the same reason, and the list drops the alarm.
  await userEvent.click(back);
  expect(await screen.findByText(alarm)).toBeTruthy();
  await waitFor(() =>
    expect(within(threads()).queryAllByRole("img", { name: alarm })).toHaveLength(0),
  );
});
