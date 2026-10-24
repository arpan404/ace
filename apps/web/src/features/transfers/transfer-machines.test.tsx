import { CommandId, DeviceId, HostId, WorkspaceId } from "@ace/protocol";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, test } from "vitest";
import { linkedMachines } from "./transfer-fixture.tsx";

configure({ asyncUtilTimeout: 10_000 });
beforeEach(() => localStorage.clear());

const origin = "git@github.com:acme/weather.git";

/** The build server's own thread, in a project it has; the build server is linked to this Mac. */
function buildThread() {
  const fixture = linkedMachines();
  const { app, build } = fixture;
  build.linkTo(app.daemon);
  build.createThread({
    id: "thread-deploy",
    workspaceId: "deploy",
    title: "Tune the deploy script",
    provider: "claude",
    hasSentMessage: true,
    details: { workspace: { id: "deploy", name: "deploy", path: "/srv/deploy" } },
  });
  return fixture;
}

test("Continue on from another machine's thread is sent from that machine", async () => {
  const { app, build, finish } = buildThread();
  await app.open("/t/thread-deploy?machine=build");
  await screen.findByRole("heading", { name: "Tune the deploy script" });
  await userEvent.click(await screen.findByRole("button", { name: "More actions" }));
  // Organize actions there wait for their follow-up; they would answer to this window's daemon.
  await screen.findByRole("menuitem", { name: /Rename/ });
  for (const name of ["Move to project…", "Archive", "Delete thread"])
    expect(screen.queryByRole("menuitem", { name })).toBeNull();
  await userEvent.click(screen.getByRole("menuitem", { name: "Continue on…" }));

  // The build server's links are listed, not this window's.
  const dialog = await screen.findByRole("dialog", { name: "Continue on another machine" });
  const machines = await within(dialog).findByRole("listbox", { name: "Machines" });
  await waitFor(() =>
    expect(
      within(machines)
        .getAllByRole("option")
        .map((each) => each.textContent),
    ).toEqual(["This Mac"]),
  );
  await userEvent.click(within(machines).getByRole("option", { name: "This Mac" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Continue on This Mac" }));
  await finish();
  expect(await within(dialog).findByText("Continued on This Mac")).toBeTruthy();

  expect(build.transfers.list().map((each) => [each.threadId, each.phase])).toEqual([
    ["thread-deploy", "completed"],
  ]);
  expect(app.daemon.transfers.list()).toEqual([]);
  expect(app.daemon.projects.list().workspaces.map((each) => each.name)).toContain("deploy");

  // Open goes to the new thread on this window's own daemon.
  await userEvent.click(within(dialog).getByRole("button", { name: "Open" }));
  expect(
    await screen.findByRole("heading", { name: "Tune the deploy script (from Build server)" }),
  ).toBeTruthy();
}, 30_000);

test("a repository with an origin the other machine lacks is cloned there first", async () => {
  const { app, build, step, finish } = linkedMachines();
  app.daemon.projects.seedFolders("/Users/dev", [
    { path: "/Users/dev/weather", git: true, remote: origin },
  ]);
  await app.open("/t/thread-forecast");
  await userEvent.click(await screen.findByRole("button", { name: "More actions" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Continue on…" }));
  const dialog = await screen.findByRole("dialog", { name: "Continue on another machine" });
  await userEvent.click(await within(dialog).findByRole("option", { name: "Build server" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Continue on Build server" }));
  await step();
  expect(await within(dialog).findByText("Build server is cloning the repository")).toBeTruthy();
  await finish();
  expect(await within(dialog).findByText("Continued on Build server")).toBeTruthy();
  expect(app.daemon.transfers.list()[0]?.method).toBe("remote");
  expect(build.projects.list().workspaces.map((each) => each.name)).toEqual(["weather"]);
}, 30_000);

test("a project the other machine has under another name is reused, keeping its own ignored files", async () => {
  const { app, build, finish } = linkedMachines();
  app.daemon.projects.seedFolders("/Users/dev", [
    { path: "/Users/dev/weather", git: true, remote: origin },
  ]);
  // The same repository there, spelled the https way and checked out as "forecast".
  build.projects.seedFolders("/srv", [
    { path: "/srv/forecast", git: true, remote: "https://GitHub.com/acme/weather" },
  ]);
  build.createThread({
    id: "thread-there",
    workspaceId: "forecast",
    title: "Earlier work",
    provider: "claude",
    details: { workspace: { id: "forecast", name: "forecast", path: "/srv/forecast" } },
  });
  await app.open("/");
  await userEvent.click(await screen.findByRole("button", { name: /^Project/ }));
  const menu = await screen.findByRole("menu");
  await userEvent.click(await within(menu).findByRole("menuitem", { name: /weather/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Open on…" }));
  const dialog = await screen.findByRole("dialog", { name: "Open on another machine" });
  await userEvent.click(await within(dialog).findByRole("option", { name: "Build server" }));
  await userEvent.click(within(dialog).getByRole("button", { name: "Open on Build server" }));
  await finish();
  expect(
    await within(dialog).findByText("Opened on Build server · kept its own copy of 1 ignored file"),
  ).toBeTruthy();
  expect(build.projects.list().workspaces.map((each) => each.name)).toEqual(["forecast"]);
  expect(app.daemon.transfers.list()[0]?.result?.workspaceId).toBe("forecast");
}, 30_000);

test("Open on in a fresh window shows the transfer already running instead of offering another", async () => {
  const { app } = linkedMachines();
  // Started before this window opened, so no push of it ever reached the window.
  app.daemon.transfers.start({
    id: CommandId.parse("earlier-open-on"),
    deviceId: DeviceId.parse("other-window"),
    payload: {
      type: "workspace.transfer",
      workspaceId: WorkspaceId.parse("weather"),
      hostId: HostId.parse("build"),
      includeChanges: true,
    },
  });
  await app.open("/");
  await userEvent.click(await screen.findByRole("button", { name: /^Project/ }));
  const menu = await screen.findByRole("menu");
  await userEvent.click(await within(menu).findByRole("menuitem", { name: /weather/ }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Open on…" }));
  const dialog = await screen.findByRole("dialog", { name: "Open on another machine" });
  expect(await within(dialog).findByText("Getting ready to send to Build server")).toBeTruthy();
  expect(within(dialog).queryByRole("listbox", { name: "Machines" })).toBeNull();
  expect(within(dialog).getByRole("button", { name: "Cancel" })).toBeTruthy();
}, 30_000);
