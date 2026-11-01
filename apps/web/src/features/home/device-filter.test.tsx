import { workbench, type FakeDaemon } from "@ace/fake-daemon";
import { CommandId, DeviceId, ThreadId } from "@ace/protocol";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

const threads = () => within(screen.getByRole("navigation", { name: "Threads" }));

async function chooseDevice(name: string) {
  await userEvent.click(await screen.findByRole("button", { name: /^Project filter:/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: /^Device filter:/ }));
  await userEvent.click(await screen.findByRole("menuitemradio", { name }));
}

test("the device filter narrows threads and drafts and remembers the choice after reload", async () => {
  const storage = memoryKeyValue();
  const made = harness({ storage, machines: [{ hostId: "build", name: "Build server" }] });
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  const build = made.machines.get("build");
  if (!build) throw new Error("Missing build server");
  // Equal thread ids on different devices must remain separate filter choices.
  for (const [daemon, title] of [
    [made.daemon, "Local task"],
    [build, "Remote task"],
  ] as const)
    daemon.createThread({
      id: "thread-device",
      workspaceId: "relay",
      title,
      provider: "claude",
      hasSentMessage: true,
    });
  await made.open("/new?project=relay");
  await userEvent.type(await screen.findByRole("combobox", { name: "Message" }), "Local draft");
  await waitFor(() => expect(threads().getByRole("link", { name: /^Remote task\./ })).toBeTruthy());
  await chooseDevice("Build server");
  await waitFor(() => expect(threads().queryByRole("link", { name: /^Local task\./ })).toBeNull());
  expect(threads().getByRole("link", { name: /^Remote task\./ })).toBeTruthy();
  expect(threads().queryByRole("link", { name: /^Local draft\./ })).toBeNull();
  // Filtering the sidebar doesn't move the open editor to another machine.
  expect(screen.getByRole("combobox", { name: "Message" }).textContent).toBe("Local draft");
  cleanup();
  await made.open("/");
  await userEvent.click(await screen.findByRole("button", { name: /^Project filter:/ }));
  expect(await screen.findByRole("menuitem", { name: "Device filter: Build server" })).toBeTruthy();
  await userEvent.keyboard("{Escape}");
  await waitFor(() => expect(threads().getByRole("link", { name: /^Remote task\./ })).toBeTruthy());
  expect(threads().queryByRole("link", { name: /^Local task\./ })).toBeNull();
  await chooseDevice("This Mac");
  await waitFor(() => expect(threads().getByRole("link", { name: /^Local task\./ })).toBeTruthy());
  expect(threads().queryByRole("link", { name: /^Remote task\./ })).toBeNull();
  expect(threads().getByRole("link", { name: /^Local draft\./ })).toBeTruthy();
  await chooseDevice("All devices");
  await waitFor(() => expect(threads().getByRole("link", { name: /^Remote task\./ })).toBeTruthy());
  expect(threads().getByRole("link", { name: /^Local task\./ })).toBeTruthy();
});

test("a single device has no device filter and ignores a saved filter for a removed device", async () => {
  const storage = memoryKeyValue();
  storage.setItem(
    "ace.home.organizer",
    JSON.stringify({ baseline: 0, project: null, device: "removed" }),
  );
  const made = harness({ storage });
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  await made.open("/new?project=relay");
  await screen.findByRole("combobox", { name: "Message" });
  expect(screen.queryByRole("button", { name: /^Device filter:/ })).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /^Project filter:/ }));
  expect(screen.queryByRole("menuitem", { name: /^Device filter:/ })).toBeNull();
  await userEvent.keyboard("{Escape}");
  expect(
    within(screen.getByRole("navigation", { name: "Threads" })).getAllByRole("link").length,
  ).toBeGreaterThan(0);
});

test("the filter button shows a shortened selected device name and reveals its full name on hover", async () => {
  const name = "Build server with a long name";
  const made = harness({ machines: [{ hostId: "build", name }] });
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  await made.open("/new?project=relay");
  await screen.findByRole("combobox", { name: "Message" });
  // Row 1 is the title row again: Threads, then Search.
  const panel = screen.getByRole("complementary", { name: "Threads" });
  expect(within(panel).getByRole("heading", { level: 2, name: "Threads" })).toBeTruthy();
  expect(within(panel).getByRole("button", { name: "Search" })).toBeTruthy();
  await chooseDevice(name);
  const control = await screen.findByRole("button", {
    name: `Project filter: All projects, Device: ${name}`,
  });
  // The device that narrows the list is the row-2 filter, truncated with an ellipsis.
  expect(control.textContent).toBe(name);
  expect(control.querySelector(".truncate")).not.toBeNull();
  // The filter and New thread share the row under the title row.
  let row: HTMLElement | null = control.parentElement;
  while (row && !within(row).queryByRole("link", { name: "New thread" })) row = row.parentElement;
  expect(row).toBeTruthy();
  const titleRow = within(panel)
    .getByRole("button", { name: "Search" })
    .closest('[data-slot="panel-top"]');
  expect(row).not.toBe(titleRow);
  await userEvent.hover(control);
  expect((await screen.findByRole("tooltip")).textContent).toBe(name);
  await userEvent.unhover(control);
  await chooseDevice("All devices");
  // With no filter on, the row-2 filter reads All projects.
  expect(screen.getByRole("button", { name: "Project filter: All projects" }).textContent).toBe(
    "All projects",
  );
});

test("choosing a device shows its name in the filter", async () => {
  const made = harness({ machines: [{ hostId: "build", name: "Build server" }] });
  for (const scenario of workbench()) made.play(scenario).runUntilBlocked();
  await made.open("/new?project=relay");
  await screen.findByRole("combobox", { name: "Message" });
  // Row 1 is the title row again: Threads, then Search.
  const panel = screen.getByRole("complementary", { name: "Threads" });
  expect(within(panel).getByRole("heading", { level: 2, name: "Threads" })).toBeTruthy();
  expect(within(panel).getByRole("button", { name: "Search" })).toBeTruthy();
  await chooseDevice("Build server");
  const control = await screen.findByRole("button", {
    name: "Project filter: All projects, Device: Build server",
  });
  expect(control.textContent).toBe("Build server");
  expect(control.getAttribute("aria-label")).toBe(
    "Project filter: All projects, Device: Build server",
  );
});

const tab = (name: RegExp) => threads().getByRole("tab", { name });
/** The thread titles the open tab lists. */
const listed = () =>
  threads()
    .queryAllByRole("link")
    .map((link) => link.getAttribute("aria-label")?.split(".")[0]);

/** Run a thread command on `daemon` as another device would. */
function run(
  daemon: FakeDaemon,
  id: string,
  payload: Parameters<FakeDaemon["command"]>[0]["payload"],
) {
  daemon.command({ id: CommandId.parse(id), deviceId: DeviceId.parse("phone"), payload });
}

test("choosing a device narrows the Inbox, Snoozed and Settled tabs to its threads and the filter names it", async () => {
  const made = harness({ machines: [{ hostId: "build", name: "Build server" }] });
  const build = made.machines.get("build");
  if (!build) throw new Error("Missing build server");
  // Each device has one thread in each tab: one in the Inbox, one snoozed, one settled.
  for (const [daemon, where] of [
    [made.daemon, "Local"],
    [build, "Remote"],
  ] as const) {
    for (const kind of ["inbox", "snoozed", "settled"])
      daemon.createThread({
        id: `thread-${kind}`,
        workspaceId: "relay",
        title: `${where} ${kind}`,
        provider: "claude",
        hasSentMessage: true,
      });
    run(daemon, `snooze-${where}`, {
      type: "thread.snooze",
      threadId: ThreadId.parse("thread-snoozed"),
      until: Date.now() + 24 * 60 * 60 * 1000,
    });
    run(daemon, `settle-${where}`, {
      type: "thread.settle",
      threadId: ThreadId.parse("thread-settled"),
    });
  }
  await made.open("/");
  await waitFor(() =>
    expect(listed()).toEqual(expect.arrayContaining(["Local inbox", "Remote inbox"])),
  );
  // Row 1 is the title row again: Threads, then Search; the filter sits below it.
  expect(screen.getByRole("heading", { level: 2, name: "Threads" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Search" })).toBeTruthy();

  await chooseDevice("Build server");
  await waitFor(() => expect(listed()).toEqual(["Remote inbox"]));
  expect(screen.getByRole("button", { name: /^Project filter:/ }).textContent).toBe("Build server");
  await userEvent.click(tab(/^Snoozed/));
  await waitFor(() => expect(listed()).toEqual(["Remote snoozed"]));
  await userEvent.click(tab(/^Settled/));
  await waitFor(() => expect(listed()).toEqual(["Remote settled"]));

  await chooseDevice("This Mac");
  await waitFor(() => expect(listed()).toEqual(["Local settled"]));
  expect(screen.getByRole("button", { name: /^Project filter:/ }).textContent).toBe("This Mac");
});
