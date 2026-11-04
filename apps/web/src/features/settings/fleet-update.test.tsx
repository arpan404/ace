import { newFleetRun, saveFleetRun, fleetRunSent, fleetUpdatePlan } from "@ace/ui-core";
import { configure, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, test } from "vitest";
import { harness, memoryKeyValue } from "@/test/harness.tsx";

configure({ asyncUtilTimeout: 10_000 });

const offer = { state: "available", available: "0.0.19", checkedAt: 1 } as const;

function fleetOf(
  machines: NonNullable<NonNullable<Parameters<typeof harness>[0]>["machines"]>,
  storage = memoryKeyValue(),
) {
  const app = harness({ machines, storage });
  const daemon = (id: string) => {
    const found = app.machines.get(id);
    if (!found) throw new Error(`Missing machine ${id}`);
    return found;
  };
  return { app, daemon };
}

const region = (name: string) => screen.findByRole("region", { name });
const allOnline = async (app: ReturnType<typeof harness>, ids: readonly string[]) =>
  waitFor(() => {
    for (const id of ids) expect(app.pool().machine(id)?.status).toBe("online");
  });

test("a machine row offers its update, and Update asks it to update when it's idle", async () => {
  const { app, daemon } = fleetOf([{ hostId: "build", name: "Build server" }]);
  daemon("build").machineUpdate.seed(offer);
  await app.open("/settings/remote");
  const machines = await region("Machines");
  expect(await within(machines).findByText("Update available · 0.0.19")).toBeTruthy();
  await userEvent.click(within(machines).getByRole("button", { name: "Update: Build server" }));
  await waitFor(() =>
    expect(daemon("build").machineUpdate.get().ask).toMatchObject({
      mode: "idle",
      version: "0.0.19",
    }),
  );
  expect(await within(machines).findByText("Downloading · 0%")).toBeTruthy();
}, 30_000);

test("Update all asks every machine it may, this computer last, and names the rest in one sentence", async () => {
  const { app, daemon } = fleetOf([
    { hostId: "build", name: "Build server" },
    { hostId: "windows", name: "Windows PC" },
    { hostId: "deb", name: "Deb box" },
    { hostId: "studio", name: "Studio", scopes: ["read"] },
    { hostId: "laptop", name: "Old laptop" },
  ]);
  app.daemon.machineUpdate.seed(offer);
  for (const id of ["build", "windows", "studio", "laptop"]) daemon(id).machineUpdate.seed(offer);
  daemon("deb").machineUpdate.seed({ ...offer, install: "standalone", blocked: "release-page" });
  await app.open("/settings/remote");
  await allOnline(app, ["build", "windows", "deb", "studio", "laptop"]);
  const updates = await region("Updates");
  expect(await within(updates).findByText("4 machines can update to 0.0.19")).toBeTruthy();
  app.crashMachine("laptop");
  expect(await within(updates).findByText("3 machines can update to 0.0.19")).toBeTruthy();
  expect(
    within(updates).getByText(
      "Old laptop is offline, Deb box updates from its release page and this window can only read Studio.",
    ),
  ).toBeTruthy();

  await userEvent.click(within(updates).getByRole("button", { name: "Update all" }));
  await waitFor(() => expect(app.daemon.machineUpdate.get().ask).not.toBeNull());
  const askedAt = (id: string) => daemon(id).machineUpdate.get().ask?.requestedAt ?? Infinity;
  const own = app.daemon.machineUpdate.get().ask?.requestedAt ?? 0;
  expect(own).toBeGreaterThan(askedAt("build"));
  expect(own).toBeGreaterThan(askedAt("windows"));
  expect(daemon("deb").machineUpdate.get().ask).toBeNull();
  expect(daemon("studio").machineUpdate.get().ask).toBeNull();
  expect(await within(updates).findByText("0 of 4 updated · 1 when back online")).toBeTruthy();
  const machines = await region("Machines");
  expect(within(machines).getByText("Updates to 0.0.19 when it's back online")).toBeTruthy();

  // The summary counts down as each machine restarts onto the release.
  while (daemon("build").machineUpdate.step());
  expect(await within(updates).findByText("1 of 4 updated · 1 when back online")).toBeTruthy();
  expect(within(machines).getByText("Updated to 0.0.19")).toBeTruthy();

  // Back online while 0.0.19 is still its latest: the laptop is asked too.
  app.pool().reconnect("laptop");
  await waitFor(() =>
    expect(daemon("laptop").machineUpdate.get().ask).toMatchObject({ version: "0.0.19" }),
  );
  expect(await within(updates).findByText("1 of 4 updated")).toBeTruthy();
}, 30_000);

test("a machine back online after a newer release came out says so instead of updating", async () => {
  const { app, daemon } = fleetOf([
    { hostId: "build", name: "Build server" },
    { hostId: "laptop", name: "Old laptop" },
  ]);
  daemon("build").machineUpdate.seed(offer);
  daemon("laptop").machineUpdate.seed(offer);
  await app.open("/settings/remote");
  await allOnline(app, ["build", "laptop"]);
  app.crashMachine("laptop");
  const updates = await region("Updates");
  await userEvent.click(await within(updates).findByRole("button", { name: "Update all" }));
  await waitFor(() => expect(daemon("build").machineUpdate.get().ask).not.toBeNull());
  daemon("laptop").machineUpdate.seed({ available: "0.0.20" });
  app.pool().reconnect("laptop");
  const machines = await region("Machines");
  expect(await within(machines).findByText("0.0.20 is out now")).toBeTruthy();
  expect(daemon("laptop").machineUpdate.get().ask).toBeNull();
  expect(within(machines).getByRole("button", { name: "Update: Old laptop" })).toBeTruthy();
}, 30_000);

test("Update all now first lists the agents working on each machine", async () => {
  const { app, daemon } = fleetOf([{ hostId: "build", name: "Build server" }]);
  app.daemon.machineUpdate.seed({ ...offer, busy: 1 });
  daemon("build").machineUpdate.seed({ ...offer, busy: 2 });
  await app.open("/settings/remote");
  await allOnline(app, ["build"]);
  const updates = await region("Updates");
  await userEvent.click(await within(updates).findByRole("button", { name: "Update all now" }));
  const dialog = await screen.findByRole("dialog", { name: "Update 2 machines now?" });
  expect(
    within(dialog).getByText(
      "3 agents are working: 2 on Build server and 1 on This Mac. They stop while their machine restarts and continue after it.",
    ),
  ).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Update all now" }));
  await waitFor(() => {
    expect(daemon("build").machineUpdate.get().ask).toMatchObject({ mode: "now" });
    expect(app.daemon.machineUpdate.get().ask).toMatchObject({ mode: "now" });
  });
}, 30_000);

test("a machine this window only reads shows its update without any action", async () => {
  const { app, daemon } = fleetOf([{ hostId: "studio", name: "Studio", scopes: ["read"] }]);
  daemon("studio").machineUpdate.seed(offer);
  await app.open("/settings/remote/studio");
  const software = await region("Software");
  expect(await within(software).findByText("ace 0.0.18. 0.0.19 is available.")).toBeTruthy();
  expect(
    await within(software).findByText(
      "This window can only read this machine. Pair it again as Administrator to update it.",
    ),
  ).toBeTruthy();
  expect(within(software).queryByRole("button")).toBeNull();
}, 30_000);

test("a failed update says why and Try again asks again", async () => {
  const { app, daemon } = fleetOf([{ hostId: "build", name: "Build server" }]);
  const build = daemon("build").machineUpdate;
  build.seed(offer, { fails: "The download was cut off." });
  await app.open("/settings/remote/build");
  const software = await region("Software");
  await userEvent.click(await within(software).findByRole("button", { name: "Update when idle" }));
  await waitFor(() => expect(build.get().state).toBe("downloading"));
  build.step();
  expect(await within(software).findByText("Failed: The download was cut off")).toBeTruthy();
  await userEvent.click(within(software).getByRole("button", { name: "Try again" }));
  await waitFor(() => expect(build.get()).toMatchObject({ state: "downloading", error: null }));
}, 30_000);

test("Update now on a machine page names the agents it stops", async () => {
  const { app, daemon } = fleetOf([{ hostId: "build", name: "Build server" }]);
  daemon("build").machineUpdate.seed({ ...offer, busy: 2 });
  await app.open("/settings/remote/build");
  const software = await region("Software");
  await userEvent.click(await within(software).findByRole("button", { name: "Update now" }));
  const dialog = await screen.findByRole("dialog", { name: "Update Build server now?" });
  expect(
    within(dialog).getByText(
      "2 agents are working there. They stop while ace restarts to 0.0.19 and continue after it.",
    ),
  ).toBeTruthy();
  await userEvent.click(within(dialog).getByRole("button", { name: "Update now" }));
  await waitFor(() =>
    expect(daemon("build").machineUpdate.get().ask).toMatchObject({ mode: "now" }),
  );
}, 30_000);

test("a run kept from before this window restarted still counts the machines that updated", async () => {
  const storage = memoryKeyValue();
  const { app, daemon } = fleetOf([{ hostId: "build", name: "Build server" }], storage);
  const status = (id: string, primary: boolean) => ({
    id,
    name: id,
    primary,
    online: true,
    access: "admin" as const,
    update: { ...app.daemon.machineUpdate.get(), ...offer },
  });
  const plan = fleetUpdatePlan([status("build", false), status("this-mac", true)]);
  const run = newFleetRun({ id: "run", plan, mode: "idle", now: Date.now() });
  saveFleetRun(
    storage,
    fleetRunSent(fleetRunSent(run, "build", Date.now()), "this-mac", Date.now()),
  );
  daemon("build").machineUpdate.seed({ version: "0.0.19", state: "updated", available: null });
  app.daemon.machineUpdate.seed({
    ...offer,
    state: "installing",
    ask: { id: "a", mode: "idle", version: "0.0.19", requestedAt: 1 },
  });
  await app.open("/settings/remote");
  const updates = await region("Updates");
  expect(await within(updates).findByText("1 of 2 updated")).toBeTruthy();
  const machines = await region("Machines");
  expect(await within(machines).findByText("Updated to 0.0.19")).toBeTruthy();
  expect(within(machines).getByText("Restarting")).toBeTruthy();
}, 30_000);
