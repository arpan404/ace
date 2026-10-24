import { CommandId, DeviceId, HostId, ThreadContinuedOn, ThreadId } from "@ace/protocol";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const workspace = { id: "weather", name: "weather", path: "/Users/dev/weather" };

/**
 * This Mac with a thread in its weather project, linked to a build server (which takes
 * transfers), a studio that is offline, a laptop that doesn't allow projects and a desk that
 * takes transfers but not agents. Each transfer
 * step runs when the test says so.
 */
function linkedMachines(options: { links?: boolean } = {}) {
  const steps: (() => void)[] = [];
  const app = harness({
    machines: [
      { hostId: "build", name: "Build server" },
      { hostId: "studio", name: "Studio" },
      { hostId: "laptop", name: "Old laptop" },
      { hostId: "desk", name: "Desk" },
    ],
    projectScheduler: (callback) => void steps.push(callback),
  });
  const machine = (id: string) => {
    const found = app.machines.get(id);
    if (!found) throw new Error(`no ${id}`);
    return found;
  };
  if (options.links !== false) {
    app.daemon.linkTo(machine("build"));
    app.daemon.linkTo(machine("studio"), { status: "offline" });
    app.daemon.linkTo(machine("laptop"), { projects: false });
    // Agents from other machines aren't let in there, but the person's transfers are.
    app.daemon.linkTo(machine("desk"), { status: "refused", access: undefined, projects: true });
  }
  app.daemon.createThread({
    id: "thread-forecast",
    workspaceId: workspace.id,
    title: "Fix the forecast cache",
    provider: "claude",
    hasSentMessage: true,
    details: { workspace },
  });
  const settled = () =>
    app.daemon.transfers
      .list()
      .every((each) => ["completed", "failed", "cancelled"].includes(each.phase));
  /** Run every transfer step queued so far, and those they queue, until all have settled. */
  const finish = async () => {
    while (!settled()) {
      await waitFor(() => expect(steps.length > 0 || settled()).toBe(true));
      while (steps.length) steps.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
  };
  /** Run one step. */
  const step = async () => {
    await waitFor(() => expect(steps.length).toBeGreaterThan(0));
    steps.shift()?.();
  };
  return { app, build: machine("build"), finish, step };
}

async function continueOn() {
  await userEvent.click(await screen.findByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Continue on…" }));
  return screen.findByRole("dialog", { name: "Continue on another machine" });
}

const strip = (words: string) =>
  screen.findByText((text, element) => element?.getAttribute("title") === words);

test("a thread continues on a linked machine: progress, then the project and a new thread there", async () => {
  const { app, build, finish, step } = linkedMachines();
  await app.open("/t/thread-forecast");
  const dialog = await continueOn();

  // Linked machines are listed; ones that can't take it now say why and can't be chosen.
  const machines = await within(dialog).findByRole("listbox", { name: "Machines" });
  await waitFor(() =>
    expect(
      within(machines)
        .getAllByRole("option")
        .map((each) => each.textContent),
    ).toEqual(["Build server", "StudioOffline", "Old laptopProjects not allowed", "Desk"]),
  );
  expect(
    within(machines).getByRole("option", { name: "Studio" }).getAttribute("aria-disabled"),
  ).toBe("true");
  await userEvent.click(within(machines).getByRole("option", { name: "Build server" }));

  // Uncommitted changes come along unless turned off.
  expect(
    within(dialog)
      .getByRole("switch", { name: "Bring uncommitted changes" })
      .getAttribute("aria-checked"),
  ).toBe("true");
  await userEvent.click(within(dialog).getByRole("button", { name: "Continue on Build server" }));

  await step();
  await step();
  expect(
    await within(dialog).findByText("Sending to Build server · 300 MB of 1.2 GB"),
  ).toBeTruthy();
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();

  await finish();
  expect(await within(dialog).findByText("Continued on Build server")).toBeTruthy();
  // The project and the continued thread now exist on the build server.
  expect(build.projects.list().workspaces.map((each) => each.name)).toEqual(["weather"]);
  const view = build.snapshot({ kind: "threads" });
  const arrived = view?.kind === "threads" ? Object.values(view.threads) : [];
  expect(arrived.map((each) => each.title)).toEqual(["Fix the forecast cache (from This Mac)"]);
  expect(arrived[0]?.details?.continuedFrom?.name).toBe("This Mac");

  // Back on this thread, its strip says where the work went, and Open goes there.
  await userEvent.keyboard("{Escape}");
  expect(await strip("Continued on Build server")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(
    await screen.findByRole("heading", { name: "Fix the forecast cache (from This Mac)" }),
  ).toBeTruthy();
  // There, it says where it came from, and Open comes back.
  expect(await strip("Continued from This Mac")).toBeTruthy();
  await userEvent.click(screen.getByRole("button", { name: "Open" }));
  expect(await screen.findByRole("heading", { name: "Fix the forecast cache" })).toBeTruthy();
}, 30_000);

test("Open on a finished transfer switches to the new thread on that machine", async () => {
  const { app, finish } = linkedMachines();
  await app.open("/t/thread-forecast");
  const dialog = await continueOn();
  await userEvent.click(await within(dialog).findByRole("option", { name: "Build server" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Continue on Build server" }));
  await finish();
  await userEvent.click(await within(dialog).findByRole("button", { name: "Open" }));
  expect(
    await screen.findByRole("heading", { name: "Fix the forecast cache (from This Mac)" }),
  ).toBeTruthy();
  expect(screen.queryByRole("dialog", { name: "Continue on another machine" })).toBeNull();
}, 30_000);

test("Cancel stops a transfer while it sends, and nothing lands on the other machine", async () => {
  const { app, build, step } = linkedMachines();
  await app.open("/t/thread-forecast");
  const dialog = await continueOn();
  await userEvent.click(await within(dialog).findByRole("option", { name: "Build server" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Continue on Build server" }));
  await step();
  await userEvent.click(await within(dialog).findByRole("button", { name: "Cancel" }));
  expect(await within(dialog).findByText("Cancelled sending to Build server")).toBeTruthy();
  await step().catch(() => undefined);
  expect(build.projects.list().workspaces).toEqual([]);
}, 30_000);

test("a failed transfer shows the other machine's words, and Try again sends it again", async () => {
  const { app, build, finish } = linkedMachines();
  app.daemon.transfers.failWith = {
    code: "digest_mismatch",
    message: "The copy on Build server didn't match. Try again.",
  };
  await app.open("/t/thread-forecast");
  const dialog = await continueOn();
  await userEvent.click(await within(dialog).findByRole("option", { name: "Build server" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Continue on Build server" }));
  await finish();
  expect(
    await within(dialog).findByText("The copy on Build server didn't match. Try again."),
  ).toBeTruthy();

  app.daemon.transfers.failWith = undefined;
  await userEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
  await finish();
  expect(await within(dialog).findByText("Continued on Build server")).toBeTruthy();
  expect(build.projects.list().workspaces.map((each) => each.name)).toEqual(["weather"]);
}, 30_000);

test("with no linked machines the chooser points to Settings › Machines", async () => {
  const { app } = linkedMachines({ links: false });
  await app.open("/t/thread-forecast");
  const dialog = await continueOn();
  expect(await within(dialog).findByText(/No other machines are linked to this one/)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("link", { name: "Settings › Machines" }));
  expect(await screen.findByRole("region", { name: "Machines" })).toBeTruthy();
}, 30_000);

test("a transfer an agent started shows on the thread the same way, with Cancel", async () => {
  const { app, finish, step } = linkedMachines();
  await app.open("/t/thread-forecast");
  await screen.findByRole("button", { name: "More actions" });
  app.daemon.transfers.start({
    id: CommandId.parse("agent-transfer"),
    deviceId: DeviceId.parse("agent-device"),
    payload: {
      type: "thread.continueOn",
      threadId: ThreadId.parse("thread-forecast"),
      hostId: HostId.parse("build"),
      includeChanges: true,
    },
  });
  await step();
  expect(await strip("Sending to Build server · 0 B of 1.2 GB")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  await finish();
  expect(await strip("Continued on Build server")).toBeTruthy();
}, 30_000);

test("a thread continued from another machine says where it came from", async () => {
  const app = harness();
  app.daemon.createThread({
    id: "thread-arrived",
    workspaceId: workspace.id,
    title: "Fix the forecast cache (from MacBook)",
    provider: "claude",
    hasSentMessage: true,
    details: {
      workspace,
      continuedFrom: ThreadContinuedOn.parse({
        hostId: "macbook",
        name: "MacBook",
        threadId: "thread-left",
        at: 1,
      }),
    },
  });
  await app.open("/t/thread-arrived");
  expect(await strip("Continued from MacBook")).toBeTruthy();
}, 30_000);

test("Open on… sends a project to a linked machine from the project's menu", async () => {
  const { app, build, finish } = linkedMachines();
  await app.open("/");
  await userEvent.click(await screen.findByRole("button", { name: /^Project/ }));
  const menu = await screen.findByRole("menu");
  await userEvent.click(await within(menu).findByRole("menuitem", { name: /weather/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Open on…" }));
  const dialog = await screen.findByRole("dialog", { name: "Open on another machine" });
  await userEvent.click(await within(dialog).findByRole("option", { name: "Build server" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Open on Build server" }));
  await finish();
  expect(await within(dialog).findByText("Opened on Build server")).toBeTruthy();
  expect(build.projects.list().workspaces.map((each) => each.name)).toEqual(["weather"]);
  const view = build.snapshot({ kind: "threads" });
  expect(view?.kind === "threads" ? Object.keys(view.threads) : []).toEqual([]);
}, 30_000);

/** The options step for continuing the thread on the build server. */
async function optionsForBuild() {
  const dialog = await continueOn();
  await userEvent.click(await within(dialog).findByRole("option", { name: "Build server" }));
  return dialog;
}

test("ignored files come along by default, and turning them off sends none", async () => {
  const { app, finish } = linkedMachines();
  await app.open("/t/thread-forecast");
  const dialog = await optionsForBuild();
  const ignored = within(dialog).getByRole("switch", { name: "Bring ignored files" });
  expect(ignored.getAttribute("aria-checked")).toBe("true");
  await userEvent.click(ignored);
  await userEvent.click(within(dialog).getByRole("button", { name: "Continue on Build server" }));
  await finish();
  expect(await within(dialog).findByText("Continued on Build server")).toBeTruthy();
  expect(app.daemon.transfers.list()[0]).toMatchObject({ phase: "completed" });
  expect(app.daemon.transfers.list()[0]?.ignoredFiles).toBeUndefined();
}, 30_000);

test("with Bring ignored files off in Settings, the toggle starts off and can still bring them", async () => {
  const { app, finish } = linkedMachines();
  app.daemon.services.settings.write("remote.transferIgnoredFiles", false);
  await app.open("/t/thread-forecast");
  const dialog = await optionsForBuild();
  const ignored = await within(dialog).findByRole("switch", {
    name: "Bring ignored files",
    checked: false,
  });
  await userEvent.click(ignored);
  await userEvent.click(within(dialog).getByRole("button", { name: "Continue on Build server" }));
  await finish();
  expect(await within(dialog).findByText("Continued on Build server")).toBeTruthy();
  expect(app.daemon.transfers.list()[0]?.ignoredFiles).toMatchObject({ files: 3 });
}, 30_000);
