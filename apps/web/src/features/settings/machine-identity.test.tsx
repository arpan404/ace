import { flakyCheckout, replayCursor, facts } from "@ace/fake-daemon";
import { cleanup, configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";
import { openWorkCard } from "@/test/open-work.ts";

configure({ asyncUtilTimeout: 10_000 });

/** The aria label of the mark beside a machine's name in Fleet's machine list. */
async function machineMark(name: string) {
  const machines = await screen.findByRole("region", { name: "Machines" });
  const link = await within(machines).findByRole("link", { name });
  return link
    .closest("[data-fleet-machine]")
    ?.querySelector("[role=img]")
    ?.getAttribute("aria-label");
}

/** Opens a machine's page from Fleet (this window's machine is listed first). */
async function openMachine(machine: "this" | string) {
  const machines = await screen.findByRole("region", { name: "Machines" });
  const [own] = await within(machines).findAllByRole("link");
  const link =
    machine === "this" ? own : await within(machines).findByRole("link", { name: machine });
  if (!link) throw new Error("No machine listed");
  await userEvent.click(link);
  // The machine page loads on first visit.
  return screen.findByRole("region", { name: "Machine" }, { timeout: 10_000 });
}

/** Opens the name and icon editor on the machine's page. */
async function editMachine(machine: "this" | string) {
  const region = await openMachine(machine);
  const edit = await within(region).findByRole("button", { name: "Edit" });
  await waitFor(() => expect(edit.hasAttribute("disabled")).toBe(false));
  await userEvent.click(edit);
}

async function renameMachine(machine: "this" | string, name: string, icon: string) {
  await editMachine(machine);
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

test("editing this machine updates Settings and the thread's details card", async () => {
  const app = harness();
  app.play(replayCursor()).runThrough("finding");
  const view = await app.open("/settings/remote");
  await within(await screen.findByRole("region", { name: "Machines" })).findByText("Fake machine", {
    exact: true,
  });
  await renameMachine("this", "Workshop Mac", "Desktop");
  const machines = screen.getByRole("region", { name: "Machine" });
  expect(await within(machines).findByText("Workshop Mac")).toBeTruthy();
  expect(within(machines).getByRole("img", { name: "desktop machine icon" })).toBeTruthy();
  expect(app.daemon.services.settings.get("host.icon")).toMatchObject({
    kind: "desktop",
    color: "green",
  });
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
  await renameMachine("Old server", "Build server", "Server");
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

test("thread rows name the device only in hover details", async () => {
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
  await app.open("/t/thread-checkout");
  const row = await screen.findByRole("link", {
    name: /Fix flaky checkout test.*Running on Build server/,
  });
  await userEvent.hover(row);
  const detail = await screen.findByLabelText(/^Details for /);
  expect(detail.textContent).toContain("Build server");
});

test("a chosen machine icon survives leaving Settings and returning to it", async () => {
  const app = harness();
  app.play(replayCursor()).runThrough("finding");
  const view = await app.open("/settings/remote");
  await within(await screen.findByRole("region", { name: "Machines" })).findByText("Fake machine", {
    exact: true,
  });
  await editMachine("this");
  const dialog = await screen.findByRole("dialog");
  await userEvent.click(within(dialog).getByRole("button", { name: "Terminal" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  view.unmount();
  await app.open("/new");
  await screen.findByRole("combobox", { name: "Message" });
  cleanup();
  await app.open("/settings/remote");
  await waitFor(async () =>
    expect(await machineMark("Fake machine")).toBe("terminal machine icon"),
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
  await within(await screen.findByRole("region", { name: "Machines" })).findByText("Workshop Mac");
  await editMachine("this");
  const dialog = await screen.findByRole("dialog");
  await userEvent.clear(within(dialog).getByRole("textbox", { name: "Machine name" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(
    await within(screen.getByRole("region", { name: "Machine" })).findByText("Fake machine"),
  ).toBeTruthy();
}, 30_000);

test("with no icon chosen, this machine shows a laptop and a paired machine a server", async () => {
  const app = harness({ machines: [{ hostId: "build", name: "Build server" }] });
  await app.open("/settings/remote");
  expect(await machineMark("This Mac")).toBe("laptop machine icon");
  expect(await machineMark("Build server")).toBe("server machine icon");
});

test("Enter in the machine name saves it", async () => {
  const app = harness();
  app.play(replayCursor()).runThrough("finding");
  await app.open("/settings/remote");
  await within(await screen.findByRole("region", { name: "Machines" })).findByText("Fake machine", {
    exact: true,
  });
  await editMachine("this");
  const dialog = await screen.findByRole("dialog");
  const input = within(dialog).getByRole("textbox", { name: "Machine name" });
  await userEvent.clear(input);
  await userEvent.type(input, "Studio Mac{Enter}");
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  const machines = screen.getByRole("region", { name: "Machine" });
  expect(await within(machines).findByText("Studio Mac")).toBeTruthy();
}, 30_000);
