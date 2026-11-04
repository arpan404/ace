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

const region = (name: string) => screen.findByRole("region", { name });

/** A button once settings load: the placeholder before then is disabled or missing. */
async function ready(scope: HTMLElement, name: string) {
  await waitFor(() =>
    expect(within(scope).getByRole<HTMLButtonElement>("button", { name }).disabled).toBe(false),
  );
  return within(scope).getByRole("button", { name });
}

test("the overview lists every machine and device with its state, and a machine's row opens its page", async () => {
  const { app } = withBuildServer();
  await app.open("/settings/remote");
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  // The scenario's machine serves Tailscale: reachable from anywhere.
  expect(
    await screen.findByText(
      "2 machines and 2 devices. Your devices can reach this computer from anywhere.",
    ),
  ).toBeTruthy();
  const machines = await region("Machines");
  expect(within(machines).getByText("this computer")).toBeTruthy();
  expect(await within(machines).findByText("Reached through Tailscale")).toBeTruthy();
  expect(await within(machines).findByText("Online")).toBeTruthy();
  const devices = await region("Devices");
  expect(within(devices).getByText("iPhone 16 Pro")).toBeTruthy();
  expect(within(devices).getByText("iPad Air")).toBeTruthy();

  app.crashMachine("build");
  expect(await within(machines).findByText(/^Offline/)).toBeTruthy();
  await userEvent.click(within(machines).getByRole("link", { name: "Build server" }));
  expect(await screen.findByRole("heading", { name: "Build server", level: 2 })).toBeTruthy();
  await userEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
}, 30_000);

test("Link all links every machine with every other, both ways", async () => {
  const { app, remote } = withBuildServer();
  await app.open("/settings/remote");
  const machines = await region("Machines");
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  await userEvent.click(await within(machines).findByRole("button", { name: "Link all machines" }));
  await waitFor(() => {
    expect(linkedHosts(app.daemon.services.fleet.links())).toEqual(["build"]);
    expect(linkedHosts(remote.services.fleet.links())).toEqual(["this-mac"]);
  });
  expect(await within(machines).findByText("Linked")).toBeTruthy();
  expect(within(machines).queryByRole("button", { name: "Link all machines" })).toBeNull();
}, 30_000);

test("a machine that can't make a pairing link says what to do, and the other direction still links", async () => {
  const { app, remote } = withBuildServer();
  remote.services.settings.write("remote.enabled", false);
  await app.open("/settings/remote");
  const machines = await region("Machines");
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  await userEvent.click(await within(machines).findByRole("button", { name: "Link all machines" }));
  // The toast's card is aria-hidden; its words are announced through the live region.
  expect(
    (await screen.findAllByText(/Turn on remote access on Build server\./)).length,
  ).toBeGreaterThan(0);
  await waitFor(() => expect(linkedHosts(remote.services.fleet.links())).toEqual(["this-mac"]));
  expect(linkedHosts(app.daemon.services.fleet.links())).toEqual([]);
}, 30_000);

test("unlinking a machine on its page asks first, then removes both directions", async () => {
  const { app, remote } = withBuildServer();
  app.daemon.linkTo(remote);
  remote.linkTo(app.daemon);
  await app.open("/settings/remote/build");
  const agents = await region("Agents");
  expect(await within(agents).findByText(/^Linked with /)).toBeTruthy();
  await userEvent.click(within(agents).getByRole("button", { name: "Unlink" }));
  const dialog = await screen.findByRole("dialog", { name: "Unlink Build server?" });
  await userEvent.click(within(dialog).getByRole("button", { name: "Unlink" }));
  await waitFor(() => {
    expect(app.daemon.services.fleet.links()).toEqual([]);
    expect(remote.services.fleet.links()).toEqual([]);
  });
  expect(await within(agents).findByRole("button", { name: "Link" })).toBeTruthy();
}, 30_000);

test("other machines' agents are set on every machine at once, and a machine that disagrees says so", async () => {
  const { app, remote } = withBuildServer();
  remote.services.settings.seed({ "remote.agentAccess": "read" });
  await app.open("/settings/remote");
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  const working = await region("Working across machines");
  expect(await within(working).findByText("Differs")).toBeTruthy();
  const agents = within(working).getByRole("group", { name: "Agents from other machines" });
  await userEvent.click(within(agents).getByRole("button", { name: "Read and act" }));
  await waitFor(() => {
    expect(app.daemon.services.settings.get("remote.agentAccess")).toBe("operate");
    expect(remote.services.settings.get("remote.agentAccess")).toBe("operate");
  });
  await waitFor(() => expect(within(working).queryByText("Differs")).toBeNull());
}, 30_000);

test("turning remote access off under More options asks first while devices reach this computer", async () => {
  const { app, remote } = withBuildServer();
  await app.open("/settings/remote");
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  await userEvent.click(await screen.findByText("More options"));
  const turnOff = await ready(document.body, "Turn off remote access");
  await userEvent.click(turnOff);
  const dialog = await screen.findByRole("dialog", { name: "Turn off remote access?" });
  expect(within(dialog).getByText(/iPhone 16 Pro and iPad Air reach this computer/)).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  expect(app.daemon.services.settings.get("remote.enabled")).not.toBe(false);
  await userEvent.click(screen.getByRole("button", { name: "Turn off remote access" }));
  await userEvent.click(
    within(await screen.findByRole("dialog", { name: "Turn off remote access?" })).getByRole(
      "button",
      { name: "Turn off" },
    ),
  );
  await waitFor(() => expect(app.daemon.services.settings.get("remote.enabled")).toBe(false));
  // It's this computer's remote access: the build server keeps its own.
  expect(remote.services.settings.get("remote.enabled")).not.toBe(false);
  const reached = await region("How this computer is reached");
  expect(await within(reached).findByText(/Off\. Nothing outside this computer/)).toBeTruthy();
}, 30_000);

test("each network turns on and off on this computer, asking before one that devices may use goes", async () => {
  const app = harness();
  await app.open("/settings/remote");
  const reached = await region("How this computer is reached");
  // The scenario's machine serves Tailscale; turning the LAN on keeps Tailscale.
  await userEvent.click(await ready(reached, "Turn on Local network"));
  await waitFor(() => expect(app.daemon.services.settings.get("remote.lan")).toBe(true));
  expect(app.daemon.services.settings.get("remote.tailscale")).toBe(true);
  expect(await within(reached).findByText("On at 192.168.1.20:4243.")).toBeTruthy();
  expect(within(reached).getByText("On at 100.64.0.1:4243.")).toBeTruthy();
  await userEvent.click(within(reached).getByRole("button", { name: "Turn off Tailscale" }));
  const dialog = await screen.findByRole("dialog", {
    name: "Turn off Tailscale on this computer?",
  });
  await userEvent.click(within(dialog).getByRole("button", { name: "Turn off" }));
  await waitFor(() => expect(app.daemon.services.settings.get("remote.tailscale")).toBe(false));
  expect(
    await within(reached).findByText(/^Off\. Turn it on to reach this computer over your tailnet/),
  ).toBeTruthy();
}, 30_000);

test("a relay of your own is added under More options and named once it serves", async () => {
  const app = harness();
  await app.open("/settings/remote");
  await userEvent.click(await screen.findByText("More options"));
  await userEvent.click(await ready(document.body, "Add"));
  await userEvent.type(
    screen.getByRole("textbox", { name: "Relay address" }),
    "wss://relay.example.com/",
  );
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => {
    expect(app.daemon.services.settings.get("remote.relayUrl")).toBe("wss://relay.example.com/");
    expect(app.daemon.services.settings.get("remote.relay")).toBe(true);
  });
  expect(await screen.findByText("On through relay.example.com.")).toBeTruthy();
}, 30_000);

test("Remove on a device asks first, then revokes it", async () => {
  const app = harness();
  await app.open("/settings/remote");
  const devices = await region("Devices");
  expect(await within(devices).findByText("iPhone 16 Pro")).toBeTruthy();
  await userEvent.click(within(devices).getByRole("button", { name: "Remove iPhone 16 Pro" }));
  await userEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  expect(within(devices).getByText("iPhone 16 Pro")).toBeTruthy();

  await userEvent.click(within(devices).getByRole("button", { name: "Remove iPhone 16 Pro" }));
  const dialog = await screen.findByRole("dialog", { name: "Remove iPhone 16 Pro?" });
  const remove = within(dialog).getByRole("button", { name: "Remove" });
  expect(remove.dataset.variant).toBe("danger");
  await userEvent.click(remove);
  await waitFor(() => expect(within(devices).queryByText("iPhone 16 Pro")).toBeNull());
  expect(within(devices).getByText("iPad Air")).toBeTruthy();
  expect(app.daemon.access.list().map((device) => device.name)).not.toContain("iPhone 16 Pro");
});

test("removing a machine from its page takes it out of the fleet", async () => {
  const { app } = withBuildServer();
  await app.open("/settings/remote/build");
  await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
  await userEvent.click(
    within(
      await screen.findByRole("dialog", { name: "Remove Build server from the fleet?" }),
    ).getByRole("button", { name: "Remove" }),
  );
  const machines = await region("Machines");
  await waitFor(() => expect(within(machines).queryByText("Build server")).toBeNull());
}, 30_000);

test("moving threads and bringing ignored files are set on every machine", async () => {
  const { app, remote } = withBuildServer();
  await app.open("/settings/remote");
  await waitFor(() => expect(app.pool().machine("build")?.status).toBe("online"));
  const working = await region("Working across machines");
  expect(
    await within(working).findByText(
      "On. Uncommitted changes and ignored files like .env go with them.",
    ),
  ).toBeTruthy();
  await userEvent.click(await ready(working, "Leave ignored files"));
  await waitFor(() => {
    expect(app.daemon.services.settings.get("remote.transferIgnoredFiles")).toBe(false);
    expect(remote.services.settings.get("remote.transferIgnoredFiles")).toBe(false);
  });
  await userEvent.click(
    within(working).getByRole("button", { name: "Turn off moving threads between machines" }),
  );
  await waitFor(() => {
    expect(app.daemon.services.settings.get("remote.agentTransfers")).toBe(false);
    expect(remote.services.settings.get("remote.agentTransfers")).toBe(false);
  });
  expect(
    await within(working).findByText("Off. Agents keep work on the machine it started on."),
  ).toBeTruthy();
}, 30_000);

test("a fleet of one says what to do next, and Add machine and Pair a device reach their flows", async () => {
  const app = harness();
  await app.open("/settings/remote");
  expect(await screen.findByText(/^Just this computer so far\./)).toBeTruthy();
  const next = await region("Next");
  await userEvent.click(within(next).getByRole("button", { name: "Add machine" }));
  const add = await screen.findByRole("dialog", { name: "Add a machine" });
  await userEvent.click(within(add).getByRole("button", { name: /^Pair with a code/ }));
  const pair = await screen.findByRole("dialog", { name: "Pair with a code" });
  expect(within(pair).getByLabelText("Pairing link or code")).toBeTruthy();
  await userEvent.click(within(pair).getByRole("button", { name: "Cancel" }));

  await userEvent.click(within(next).getByRole("button", { name: "Pair a device" }));
  const device = await screen.findByRole("dialog", { name: "Pair a device" });
  expect(within(device).getByRole("button", { name: "Create link" })).toBeTruthy();
}, 30_000);
