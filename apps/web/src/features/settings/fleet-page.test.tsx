import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

function withBuildServer() {
  const app = harness({ machines: [{ hostId: "build", name: "Build server" }] });
  const remote = app.machines.get("build");
  if (!remote) throw new Error("Missing machine");
  return { app, remote };
}

const linkedHosts = (links: readonly { hostId?: string | undefined }[]) =>
  links.map((link) => link.hostId);

test("Link all links every machine with every other, both ways", async () => {
  const { app, remote } = withBuildServer();
  await app.open("/settings/remote");
  const machines = await screen.findByRole("region", { name: "Machines" });
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  await userEvent.click(await within(machines).findByRole("button", { name: "Link all" }));
  await waitFor(() => {
    expect(linkedHosts(app.daemon.services.fleet.links())).toEqual(["build"]);
    expect(linkedHosts(remote.services.fleet.links())).toEqual(["this-mac"]);
  });
  expect((await within(machines).findAllByText("Linked with all")).length).toBe(2);
  expect(within(machines).queryByRole("button", { name: "Link all" })).toBeNull();
}, 30_000);

test("a machine that can't make a pairing link says what to do, and the other direction still links", async () => {
  const { app, remote } = withBuildServer();
  remote.services.settings.write("remote.enabled", false);
  await app.open("/settings/remote");
  const machines = await screen.findByRole("region", { name: "Machines" });
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  await userEvent.click(await within(machines).findByRole("button", { name: "Link all" }));
  // The toast's card is aria-hidden; its words are announced through the live region.
  expect(
    (await screen.findAllByText(/Turn on remote access on Build server\./)).length,
  ).toBeGreaterThan(0);
  expect(screen.queryByText(/unavailable/)).toBeNull();
  await waitFor(() => expect(linkedHosts(remote.services.fleet.links())).toEqual(["this-mac"]));
  expect(linkedHosts(app.daemon.services.fleet.links())).toEqual([]);
}, 30_000);

test("unlinking two machines on a machine's page asks first, then removes both directions", async () => {
  const { app, remote } = withBuildServer();
  await app.open("/settings/remote");
  const machines = await screen.findByRole("region", { name: "Machines" });
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  await userEvent.click(await within(machines).findByRole("button", { name: "Link all" }));
  await within(machines).findAllByText("Linked with all");
  await userEvent.click(within(machines).getByRole("link", { name: "Build server" }));
  const links = await screen.findByRole("region", { name: "Links" });
  const row = (await within(links).findByText("This Mac")).closest("tr");
  if (!row) throw new Error("No link row");
  expect(within(row).getAllByText("Read and act")).toHaveLength(2);
  await userEvent.click(within(row).getByRole("button", { name: "Actions for This Mac" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Unlink" }));
  const dialog = await screen.findByRole("dialog", { name: "Unlink Build server and This Mac?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Unlink" }));
  await waitFor(() => {
    expect(app.daemon.services.fleet.links()).toEqual([]);
    expect(remote.services.fleet.links()).toEqual([]);
  });
  expect(await within(links).findByRole("button", { name: "Link" })).toBeTruthy();
}, 30_000);

test("access rules land on every machine, and a machine that disagrees says Differs", async () => {
  const { app, remote } = withBuildServer();
  remote.services.settings.seed({ "remote.agentAccess": "read" });
  await app.open("/settings/remote");
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  const access = await screen.findByRole("region", { name: "Access" });
  expect(await within(access).findByText("Differs")).toBeTruthy();
  const agents = within(access).getByRole("group", { name: "Agents from other machines" });
  await userEvent.click(within(agents).getByRole("button", { name: "Read and act" }));
  await waitFor(() => {
    expect(app.daemon.services.settings.get("remote.agentAccess")).toBe("operate");
    expect(remote.services.settings.get("remote.agentAccess")).toBe("operate");
  });
  await waitFor(() => expect(within(access).queryByText("Differs")).toBeNull());
}, 30_000);

test("turning remote access off while other machines are connected asks first", async () => {
  const { app, remote } = withBuildServer();
  await app.open("/settings/remote");
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  const toggle = await screen.findByRole("switch", { name: "Remote access", checked: true });
  await userEvent.click(toggle);
  const dialog = await screen.findByRole("dialog", { name: "Turn off remote access everywhere?" });
  expect(within(dialog).getByText(/This window reaches Build server/)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(app.daemon.services.settings.get("remote.enabled")).not.toBe(false);
  await userEvent.click(toggle);
  await userEvent.click(
    within(
      await screen.findByRole("dialog", { name: "Turn off remote access everywhere?" }),
    ).getByRole("button", { name: "Turn off" }),
  );
  await waitFor(() => {
    expect(app.daemon.services.settings.get("remote.enabled")).toBe(false);
    expect(remote.services.settings.get("remote.enabled")).toBe(false);
  });
}, 30_000);

test("with one machine, remote access and its network are saved without asking", async () => {
  const app = harness();
  await app.open("/settings/remote");
  // The control replaces its placeholder once settings load: look it up again after.
  await waitFor(() =>
    expect(screen.getByRole("combobox", { name: "Reached over" }).hasAttribute("disabled")).toBe(
      false,
    ),
  );
  await userEvent.click(screen.getByRole("combobox", { name: "Reached over" }));
  await userEvent.click(await screen.findByRole("option", { name: "Local network" }));
  await waitFor(() => expect(app.daemon.services.settings.get("remote.transport")).toBe("lan"));
  expect(
    screen.getByText("Same network only. Browsers must trust its HTTPS certificate."),
  ).toBeTruthy();
  await userEvent.click(screen.getByRole("switch", { name: "Remote access" }));
  await waitFor(() => expect(app.daemon.services.settings.get("remote.enabled")).toBe(false));
  expect(screen.queryByRole("dialog")).toBeNull();
}, 30_000);

test("a paired device is listed once, and revoking it asks first", async () => {
  const app = harness();
  await app.open("/settings/remote");
  const devices = await screen.findByRole("region", { name: "Devices" });
  expect(await within(devices).findByText("iPhone 16 Pro")).toBeTruthy();
  await userEvent.click(within(devices).getByRole("button", { name: "Actions for iPhone 16 Pro" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Revoke" }));
  await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  expect(within(devices).getByText("iPhone 16 Pro")).toBeTruthy();

  await userEvent.click(within(devices).getByRole("button", { name: "Actions for iPhone 16 Pro" }));
  await userEvent.click(await screen.findByRole("menuitem", { name: "Revoke" }));
  const dialog = await screen.findByRole("dialog", { name: "Revoke iPhone 16 Pro?" });
  const revoke = within(dialog).getByRole("button", { name: "Revoke" });
  expect(revoke.dataset.variant).toBe("danger");
  await userEvent.click(revoke);
  await waitFor(() => expect(within(devices).queryByText("iPhone 16 Pro")).toBeNull());
  expect(within(devices).getByText("iPad Air")).toBeTruthy();
  expect(app.daemon.access.list().map((device) => device.name)).not.toContain("iPhone 16 Pro");
});

test("an offline machine says so; its page reconnects it, and removing it takes it out of the fleet", async () => {
  const { app } = withBuildServer();
  await app.open("/settings/remote");
  const machines = await screen.findByRole("region", { name: "Machines" });
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  app.crashMachine("build");
  expect(await within(machines).findByText(/Couldn't reach this machine|Offline/)).toBeTruthy();
  await userEvent.click(within(machines).getByRole("link", { name: "Build server" }));
  await userEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
  await userEvent.click(
    within(
      await screen.findByRole("dialog", { name: "Remove Build server from the fleet?" }),
    ).getByRole("button", { name: "Remove" }),
  );
  const fleet = await screen.findByRole("region", { name: "Machines" });
  await waitFor(() => expect(within(fleet).queryByText("Build server")).toBeNull());
}, 30_000);

test("agents may move work to other machines until the switch is turned off on every machine", async () => {
  const { app, remote } = withBuildServer();
  await app.open("/settings/remote");
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  const access = await screen.findByRole("region", { name: "Access" });
  const toggle = await within(access).findByRole("switch", {
    name: "Agents can move projects and threads to other machines",
    checked: true,
  });
  await userEvent.click(toggle);
  await waitFor(() => {
    expect(app.daemon.services.settings.get("remote.agentTransfers")).toBe(false);
    expect(remote.services.settings.get("remote.agentTransfers")).toBe(false);
  });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
}, 30_000);

test("Bring ignored files is on until it is turned off on every machine", async () => {
  const { app, remote } = withBuildServer();
  await app.open("/settings/remote");
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  const access = await screen.findByRole("region", { name: "Access" });
  expect(
    within(access).getByText(
      "Local files Git ignores, such as .env and local config, go too. Dependency folders are rebuilt there instead.",
    ),
  ).toBeTruthy();
  const toggle = await within(access).findByRole("switch", {
    name: "Bring ignored files",
    checked: true,
  });
  await userEvent.click(toggle);
  await waitFor(() => {
    expect(app.daemon.services.settings.get("remote.transferIgnoredFiles")).toBe(false);
    expect(remote.services.settings.get("remote.transferIgnoredFiles")).toBe(false);
  });
  expect(toggle.getAttribute("aria-checked")).toBe("false");
}, 30_000);
