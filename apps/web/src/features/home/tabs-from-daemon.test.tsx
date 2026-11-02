import { facts, type FakeDaemon } from "@ace/fake-daemon";
import { CommandId, DeviceId, ThreadId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { createIdleTask } from "@/test/tasks.ts";

// The shared sidebar loads on demand in production; these tests start with its body ready.
await import("./home-sidebar.tsx");

afterEach(() => localStorage.clear());

/*
 * The Threads panel lists the daemon's tabs as given (ADR 0107): the order and tab come from
 * each entry's place, not from a rule this window runs, and a thread that moves tabs moves on
 * its own while the other rows stay as they are.
 */

const threads = () => screen.getByRole("navigation", { name: "Threads" });
const titles = () =>
  within(threads())
    .queryAllByRole("link")
    .map((link) => ["First", "Second"].find((name) => link.textContent?.includes(name)))
    .filter(Boolean);
const link = (name: RegExp) => within(threads()).queryByRole("link", { name });

const works: Parameters<FakeDaemon["apply"]>[1] = [facts.rootAgent("codex"), facts.turn("root")];

async function openHome() {
  const app = harness();
  createIdleTask(app.daemon, { id: "first", workspaceId: "w", title: "First", provider: "codex" });
  createIdleTask(app.daemon, {
    id: "second",
    workspaceId: "w",
    title: "Second",
    provider: "codex",
  });
  return app;
}

test("the Inbox shows the daemon's order even where this window's own rule would differ", async () => {
  const app = await openHome();
  // The daemon places by creation; this window's sort setting says live activity.
  const place = app.daemon.placeInput.bind(app.daemon);
  app.daemon.placeInput = () => ({ ...place(), sortBy: "created" });
  // Working would lift First to the top by activity; by creation the newer Second leads.
  app.daemon.apply("first", works);
  await app.open("/");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  await waitFor(() => expect(titles()).toEqual(["Second", "First"]));
});

test("settling a thread moves it to Settled on its own; the row that stays is the same row", async () => {
  const app = await openHome();
  await app.open("/");
  await within(await screen.findByRole("navigation", { name: "Threads" })).findAllByRole("link");
  await waitFor(() => expect(titles()).toEqual(["Second", "First"]));
  const kept = link(/^First/);
  app.daemon.command({
    id: CommandId.parse("settle-second"),
    deviceId: DeviceId.parse("other-device"),
    payload: { type: "thread.settle", threadId: ThreadId.parse("second") },
  });
  await waitFor(() => expect(titles()).toEqual(["First"]));
  // Not a reload: the row that stayed is the very element it was.
  expect(link(/^First/)).toBe(kept);
  await userEvent.click(within(threads()).getByRole("tab", { name: /^Settled/ }));
  await waitFor(() => expect(link(/^Second/)).not.toBeNull());
});
