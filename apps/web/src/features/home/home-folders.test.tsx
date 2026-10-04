import { facts, workbench, type Scenario } from "@ace/fake-daemon";
import { ThreadId } from "@ace/protocol";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

const threads = () => screen.getByRole("navigation", { name: "Threads" });
const links = () =>
  within(threads())
    .queryAllByRole("link")
    .map((link) => link.textContent);
const folder = (name: string) =>
  within(threads()).getByRole("button", { name: new RegExp(`^${name}`) });

/** A working thread in `project`. */
function working(n: number, project = "relay"): Scenario {
  return {
    thread: {
      id: `thread-${project}-${n}`,
      workspaceId: project,
      title: `${project} task ${n}`,
      provider: "claude",
    },
    steps: [
      { kind: "facts", label: "seeded", facts: [facts.rootAgent("claude"), facts.turn("root")] },
    ],
  };
}

/** Seven working threads in relay. */
function busyRelay(storage = memoryKeyValue()) {
  const app = harness({ storage });
  for (let n = 1; n <= 7; n++) app.play(working(n)).runUntilBlocked();
  return app;
}

async function listed() {
  const nav = await screen.findByRole("navigation", { name: "Threads" });
  await within(nav).findAllByRole("link");
}

test("a folder shows its first five threads, then Show more; Show less goes back", async () => {
  await busyRelay().open("/new");
  await listed();
  expect(links()).toHaveLength(5);

  await userEvent.click(within(threads()).getByRole("button", { name: "Show more in relay" }));
  await waitFor(() => expect(links()).toHaveLength(7));
  await userEvent.click(within(threads()).getByRole("button", { name: "Show less in relay" }));
  await waitFor(() => expect(links()).toHaveLength(5));
});

test("the open thread shows in its folder even past the first five", async () => {
  const app = busyRelay();
  await app.open("/new");
  await listed();
  const hidden = ["1", "2", "3", "4", "5", "6", "7"]
    .map((n) => `relay task ${n}`)
    .find((name) => !links().some((text) => text?.startsWith(name)));
  if (!hidden) throw new Error("Every thread already shows");
  await userEvent.keyboard("{Meta>}k{/Meta}");
  await userEvent.type(await screen.findByRole("combobox", { name: "Search commands" }), hidden);
  await userEvent.keyboard("{Enter}");
  await screen.findByRole("heading", { level: 1, name: hidden });
  await waitFor(() =>
    expect(within(threads()).getByRole("link", { name: new RegExp(`^${hidden}`) })).toBeTruthy(),
  );
  expect(links()).toHaveLength(6);
});

test("closed folders come back closed on a fresh load, and Show more starts over", async () => {
  const storage = memoryKeyValue();
  const first = busyRelay(storage);
  for (const scenario of workbench()) first.play(scenario).runUntilBlocked();
  const view = await first.open("/new");
  await listed();
  await userEvent.click(folder("billing-api"));
  await waitFor(() =>
    expect(within(threads()).queryByRole("link", { name: /^Partial refunds/ })).toBeNull(),
  );
  // Closed, it still says a thread inside needs you.
  expect(within(folder("billing-api")).getByRole("img", { name: "A thread here needs you" }));
  await userEvent.click(within(threads()).getByRole("button", { name: "Show more in relay" }));
  await waitFor(() =>
    expect(within(threads()).getByRole("button", { name: "Show less in relay" })).toBeTruthy(),
  );
  view.unmount();

  // A new page: only what was written to storage carries over.
  const disk = memoryKeyValue();
  for (const [key, value] of storage.data) disk.setItem(key, value);
  const again = busyRelay(disk);
  for (const scenario of workbench()) again.play(scenario).runUntilBlocked();
  await again.open("/new");
  await listed();
  expect(folder("billing-api").getAttribute("aria-expanded")).toBe("false");
  expect(within(threads()).queryByRole("link", { name: /^Partial refunds/ })).toBeNull();
  expect(within(threads()).getByRole("button", { name: "Show more in relay" })).toBeTruthy();
  await userEvent.click(folder("billing-api"));
  expect(await within(threads()).findByRole("link", { name: /^Partial refunds/ })).toBeTruthy();
});

test("a thread whose id looks like a folder's still shows once, beside its folder", async () => {
  const app = harness();
  app.play(working(1)).runUntilBlocked();
  app
    .play({
      ...working(2),
      thread: { ...working(2).thread, id: "folder:relay", title: "Named like a folder" },
    })
    .runUntilBlocked();
  await app.open("/new");
  await listed();
  expect(folder("relay").getAttribute("aria-expanded")).toBe("true");
  expect(within(threads()).getAllByRole("link", { name: /^Named like a folder/ })).toHaveLength(1);
  expect(within(threads()).getAllByRole("link", { name: /^relay task 1/ })).toHaveLength(1);
});

test("a pinned thread leads the list under Pinned and leaves its folder", async () => {
  const app = busyRelay();
  await app.open("/new");
  await listed();
  await app.client.command({
    type: "thread.pin",
    threadId: ThreadId.parse("thread-relay-3"),
    pinned: true,
  });
  await waitFor(() => expect(links()[0]).toMatch(/^relay task 3/));
  const top = within(threads()).getAllByRole("link")[0];
  if (!top) throw new Error("The list is empty");
  expect(within(top).getByRole("img", { name: "Pinned" })).toBeTruthy();
  expect(within(threads()).getByRole("heading", { name: "Pinned" })).toBeTruthy();
  expect(links().filter((text) => text?.includes("relay task 3"))).toHaveLength(1);
});
