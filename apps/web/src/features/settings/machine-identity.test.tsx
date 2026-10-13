import { flakyCheckout, replayCursor, facts } from "@ace/fake-daemon";
import { cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { openWorkCard } from "@/test/open-work.ts";

async function renameMachine(button: string, name: string, icon: string) {
  const edit = await screen.findByRole("button", { name: button });
  await waitFor(() => expect(edit.hasAttribute("disabled")).toBe(false));
  await userEvent.click(edit);
  await userEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
  const dialog = await screen.findByRole("dialog");
  const input = within(dialog).getByRole("textbox", { name: "Machine name" });
  await userEvent.clear(input);
  await userEvent.type(input, name);
  await userEvent.click(within(dialog).getByRole("button", { name: icon }));
  await userEvent.click(within(dialog).getByRole("combobox", { name: "Icon colour" }));
  await userEvent.click(await screen.findByRole("option", { name: "Green" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
}

test("editing this machine updates Settings, the new-thread environment and the thread's details card", async () => {
  const app = harness();
  app.play(replayCursor()).runThrough("finding");
  let view = await app.open("/settings/remote");
  await screen.findByText("Fake machine", { exact: true });
  await renameMachine("Actions for Fake machine", "Workshop Mac", "Desktop");
  const machines = screen.getByRole("region", { name: "Machines" });
  expect(await within(machines).findByText("Workshop Mac")).toBeTruthy();
  expect(within(machines).getByRole("img", { name: "desktop machine icon" })).toBeTruthy();
  expect(app.daemon.services.settings.get("host.icon")).toMatchObject({
    kind: "desktop",
    color: "green",
  });
  view.unmount();
  view = await app.open("/new");
  // New thread names the machine in the Worktree toggle's tooltip (8e2126e5f).
  await userEvent.hover(await screen.findByText("Worktree"));
  expect((await screen.findByRole("tooltip")).textContent).toContain("Runs on Workshop Mac");
  view.unmount();
  await app.open("/t/thread-replay-cursor");
  await screen.findByRole("feed", { name: "Transcript" });
  const card = await openWorkCard();
  expect(within(card).getByRole("button", { name: /^Workshop Mac, / })).toBeTruthy();
});

test("editing a paired machine saves on that host and replaces stale thread labels", async () => {
  const app = harness({ machines: [{ hostId: "build", name: "Old server" }] });
  const scenario = replayCursor();
  app
    .play({
      ...scenario,
      thread: {
        ...scenario.thread,
        details: { ...scenario.thread.details, machine: { host: "build", name: "Old server" } },
      },
    })
    .runThrough("finding");
  let view = await app.open("/settings/remote");
  await renameMachine("Actions for Old server", "Build server", "Server");
  expect(app.machines.get("build")?.services.settings.get("host.displayName")).toBe("Build server");
  expect(app.machines.get("build")?.services.settings.get("host.icon")).toMatchObject({
    kind: "server",
  });
  view.unmount();
  view = await app.open("/");
  const sidebar = await screen.findByRole("list", { name: "Threads" });
  const row = await within(sidebar).findByRole("link", {
    name: /Replay cursor resets.*Running on Build server/,
  });
  // Two devices are connected: the row shows the machine's icon, never its name (3ab05f4f4).
  expect(within(row).getByRole("img", { name: "server machine icon" })).toBeTruthy();
  await userEvent.hover(row);
  expect((await screen.findByLabelText(/^Details for /)).textContent).toContain("Build server");
  expect(sidebar.textContent).not.toContain("Old server");
  view.unmount();
});

test("this machine's name stays out of the task row while its project remains visible", async () => {
  const app = harness();
  app.daemon.services.settings.seed({ "host.displayName": "Workshop Mac" });
  app.play(replayCursor()).runThrough("finding");
  await app.open("/");
  const sidebar = await screen.findByRole("list", { name: "Threads" });
  await within(sidebar).findByRole("link", { name: /Replay cursor resets/ });
  expect(sidebar.textContent).not.toContain("Workshop Mac");
});

test("empty threads stay out of tasks until a user message is sent, even after a rename", async () => {
  const app = harness();
  app.daemon.createThread({
    id: "empty",
    title: "New thread",
    workspaceId: "ace",
    provider: "opencode",
  });
  await app.open("/");
  await screen.findByText("No threads yet");
  expect(screen.queryByRole("link", { name: /^New thread\./ })).toBeNull();
  app.daemon.apply("empty", [
    facts.rootAgent("opencode"),
    facts.turn("root"),
    facts.message("root", "sent", "user", "Hello"),
  ]);
  expect(await screen.findByRole("link", { name: /^New thread\./ })).toBeTruthy();
});

test("Activity keeps device names in thread hover details instead of compact rows", async () => {
  const app = harness({ machines: [{ hostId: "build", name: "Build server" }] });
  const scenario = flakyCheckout();
  app
    .play({
      ...scenario,
      thread: {
        ...scenario.thread,
        details: { ...scenario.thread.details, machine: { host: "build", name: "Stale server" } },
      },
    })
    .runThrough("approval-requested");
  await app.open("/activity");
  const feed = await within(
    await screen.findByRole("complementary", { name: "Activity" }),
  ).findByRole("list", { name: "Activity" });
  expect(feed.textContent).not.toContain("Stale server");
  expect(feed.textContent).not.toContain("Build server");
  await app.open("/t/thread-checkout");
  const row = await screen.findByRole("link", {
    name: /Fix flaky checkout test.*Running on Build server/,
  });
  await userEvent.hover(row);
  const detail = await screen.findByLabelText(/^Details for /);
  expect(detail.textContent).toContain("Build server");
});

test("a chosen emoji survives leaving Settings and returning to it", async () => {
  const app = harness();
  app.play(replayCursor()).runThrough("finding");
  const view = await app.open("/settings/remote");
  await screen.findByText("Fake machine", { exact: true });
  const edit = await screen.findByRole("button", {
    name: /Actions for (Fake machine|Workshop Mac)/,
  });
  await waitFor(() => expect(edit.hasAttribute("disabled")).toBe(false));
  await userEvent.click(edit);
  await userEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(within(dialog).getByRole("button", { name: /^Emoji$/ }));
  const emoji = within(dialog).getByRole("textbox", { name: "Emoji" });
  await userEvent.clear(emoji);
  await userEvent.type(emoji, "🦊");
  await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  view.unmount();
  await app.open("/new");
  await screen.findByRole("combobox", { name: "Message" });
  cleanup();
  await app.open("/settings/remote");
  const machines = await screen.findByRole("region", { name: "Machines" });
  expect((await within(machines).findByRole("img", { name: "🦊 machine icon" })).textContent).toBe(
    "🦊",
  );
});

test("a paired machine's updated host identity replaces the cached label after reconnect", async () => {
  const app = harness({ machines: [{ hostId: "build", name: "Old server" }] });
  const scenario = replayCursor();
  app
    .play({
      ...scenario,
      thread: {
        ...scenario.thread,
        details: {
          ...scenario.thread.details,
          machine: { host: "build", name: "Old server" },
        },
      },
    })
    .runThrough("finding");
  await app.open("/");
  const sidebar = await screen.findByRole("list", { name: "Threads" });
  await within(sidebar).findByRole("link", { name: /Replay cursor resets.*Running on Old server/ });
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  app.machines.get("build")?.services.settings.seed({
    "host.displayName": "Build server",
    "host.icon": { kind: "cloud", color: "blue" },
  });
  app.crashMachine("build");
  await app.pool().reconnect("build");
  const row = await within(sidebar).findByRole("link", {
    name: /Replay cursor resets.*Running on Build server/,
  });
  expect(within(row).getByRole("img", { name: "cloud machine icon" })).toBeTruthy();
  await userEvent.hover(row);
  const details = await screen.findByLabelText(/^Details for /);
  expect(details.textContent).toContain("Build server");
  expect(within(details).getByRole("img", { name: "cloud machine icon" })).toBeTruthy();
  expect(sidebar.textContent).not.toContain("Old server");
});

test("clearing a custom machine name restores the computer name", async () => {
  const app = harness();
  app.daemon.services.settings.seed({ "host.displayName": "Workshop Mac" });
  await app.open("/settings/remote");
  const edit = await screen.findByRole("button", {
    name: /Actions for (Fake machine|Workshop Mac)/,
  });
  await waitFor(() => expect(edit.hasAttribute("disabled")).toBe(false));
  await userEvent.click(edit);
  await userEvent.click(await screen.findByRole("menuitem", { name: "Rename" }));
  const dialog = await screen.findByRole("dialog");
  await userEvent.clear(within(dialog).getByRole("textbox", { name: "Machine name" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    await within(screen.getByRole("region", { name: "Machines" })).findByText("Fake machine"),
  ).toBeTruthy();
});
