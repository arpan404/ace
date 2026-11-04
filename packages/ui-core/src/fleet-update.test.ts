import { MachineUpdate } from "@ace/protocol";
import { expect, test } from "vitest";
import { fleetMachineLine, fleetUpdateHeadline } from "./fleet-update-headline.ts";
import { cannotUpdateSentence, fleetUpdateOffer, fleetUpdatePlan } from "./fleet-update-plan.ts";
import {
  fleetRunFailed,
  fleetRunLine,
  fleetRunNextSends,
  fleetRunRetry,
  fleetRunSent,
  fleetRunState,
  fleetRunSummary,
  loadFleetRun,
  newFleetRun,
  saveFleetRun,
  type FleetUpdateRun,
} from "./fleet-update-run.ts";
import type { UpdateMachine } from "./machine-update-words.ts";

const status = (fields: Partial<MachineUpdate> = {}): MachineUpdate =>
  MachineUpdate.parse({
    version: "0.0.18",
    platform: "linux",
    arch: "x64",
    install: "standalone",
    state: "available",
    available: "0.0.19",
    releaseUrl: null,
    blocked: null,
    ask: null,
    busy: 0,
    percent: null,
    error: null,
    last: null,
    checkedAt: 1,
    ...fields,
  });

const machine = (
  id: string,
  update: Partial<MachineUpdate> | undefined = {},
  fields: Partial<UpdateMachine> = {},
): UpdateMachine => ({
  id,
  name: id,
  primary: false,
  online: true,
  access: "admin",
  update: update === undefined ? undefined : status(update),
  ...fields,
});

const day = 24 * 60 * 60 * 1000;

const fleet = [
  machine("This Mac", { busy: 1 }, { primary: true }),
  machine("Build server", { busy: 2 }),
  machine("Windows PC"),
  machine("Up to date", { available: null, state: "none", version: "0.0.19" }),
  machine("Old laptop", { available: "0.0.19" }, { online: false }),
  machine("Deb box", { blocked: "release-page" }),
  machine("Kitchen Mac", {}, { access: "read" }),
  machine("Busy box", {
    state: "waiting",
    ask: { id: "x", mode: "idle", version: "0.0.19", requestedAt: 1 },
  }),
];

test("Update all asks every machine that may update, the one this window runs on last", () => {
  const plan = fleetUpdatePlan(fleet);
  expect(plan.targets.map((target) => target.id)).toEqual([
    "Build server",
    "Windows PC",
    "This Mac",
  ]);
  expect(fleetUpdateOffer(plan)).toBe("3 machines can update to 0.0.19");
});

test("machines Update all can't reach are named in one sentence with why", () => {
  expect(cannotUpdateSentence(fleetUpdatePlan(fleet).cannot)).toBe(
    "Old laptop is offline, Deb box updates from its release page and this window can only read Kitchen Mac.",
  );
});

test.each([
  [
    [machine("a", { available: "0.0.19" }), machine("b", { available: "0.0.20" })],
    "2 machines can update",
  ],
  [[machine("Build server")], "Build server can update to 0.0.19"],
  [[machine("a", { available: null, state: "none" })], null],
] as const)("the offer names the release only when every machine agrees", (machines, offer) => {
  expect(fleetUpdateOffer(fleetUpdatePlan(machines))).toBe(offer);
});

const start = (mode: "idle" | "now" = "idle") =>
  newFleetRun({ id: "run", plan: fleetUpdatePlan(fleet), mode, now: 0 });

test("a run waiting for idle includes offline machines; one updating now doesn't", () => {
  expect(start("idle").machines.map((entry) => entry.id)).toEqual([
    "Build server",
    "Windows PC",
    "Old laptop",
    "This Mac",
  ]);
  expect(start("now").machines.map((entry) => entry.id)).toEqual([
    "Build server",
    "Windows PC",
    "This Mac",
  ]);
});

test("the machine this window runs on is asked only once the others have been", () => {
  const run = start();
  expect(fleetRunNextSends(run, fleet, 1).map((entry) => entry.id)).toEqual([
    "Build server",
    "Windows PC",
  ]);
  const asked = fleetRunFailed(fleetRunSent(run, "Build server", 1), "Windows PC", "it refused");
  expect(fleetRunNextSends(asked, fleet, 2).map((entry) => entry.id)).toEqual(["This Mac"]);
});

/** The fleet after `ids` restarted onto 0.0.19. */
const updatedFleet = (ids: readonly string[]) =>
  fleet.map((entry) =>
    ids.includes(entry.id)
      ? { ...entry, update: status({ version: "0.0.19", available: null, state: "updated" }) }
      : entry,
  );

/** Every machine as if it were online. */
const online = (machines: readonly UpdateMachine[]) =>
  machines.map((entry) => Object.assign({}, entry, { online: true }));

/** The fleet with the old laptop back online, offered `available`. */
const back = (available: string) =>
  fleet.map((entry) => (entry.id === "Old laptop" ? machine("Old laptop", { available }) : entry));

const sentAll = (run: FleetUpdateRun) =>
  ["Build server", "Windows PC", "This Mac"].reduce((next, id) => fleetRunSent(next, id, 1), run);

test("the summary counts down as machines report updated", () => {
  const run = sentAll(start());
  expect(fleetRunSummary(run, fleet, 2).words).toBe("0 of 4 updated · 1 when back online");
  expect(fleetRunSummary(run, updatedFleet(["Build server", "Windows PC"]), 2).words).toBe(
    "2 of 4 updated · 1 when back online",
  );
  const all = online(updatedFleet(["Build server", "Windows PC", "This Mac", "Old laptop"]));
  expect(fleetRunSummary(run, all, 3)).toMatchObject({
    words: "All 4 machines updated to 0.0.19",
    done: true,
  });
});

test("a failure is counted and its row offers Try again, which asks it again", () => {
  const run = sentAll(start());
  const failing = fleet.map((entry) =>
    entry.id === "Windows PC" ? machine(entry.id, { state: "failed", error: "Disk full." }) : entry,
  );
  expect(fleetRunSummary(run, failing, 2).words).toBe(
    "0 of 4 updated · 1 failed · 1 when back online",
  );
  const entry = run.machines.find((each) => each.id === "Windows PC");
  if (!entry) throw new Error("missing");
  const state = fleetRunState(
    run,
    entry,
    failing.find((each) => each.id === "Windows PC"),
    2,
  );
  expect(fleetRunLine(state, entry, failing[2])).toMatchObject({
    words: "Failed: Disk full",
    action: "retry",
  });
  const retried = fleetRunRetry(run, "Windows PC", "0.0.19");
  const recovered = fleet.map((each) => (each.id === "Windows PC" ? machine(each.id) : each));
  expect(fleetRunNextSends(retried, recovered, 3).map((each) => each.id)).toEqual(["Windows PC"]);
});

test("an offline machine that's back picks the run up while its release is still the latest", () => {
  const run = sentAll(start());
  expect(fleetRunNextSends(run, back("0.0.19"), 2).map((entry) => entry.id)).toEqual([
    "Old laptop",
  ]);
  expect(fleetRunNextSends(run, back("0.0.20"), 2)).toEqual([]);
  const entry = run.machines.find((each) => each.id === "Old laptop");
  if (!entry) throw new Error("missing");
  const newer = back("0.0.20").find((each) => each.id === "Old laptop");
  expect(fleetRunLine(fleetRunState(run, entry, newer, 2), entry, newer)).toMatchObject({
    words: "0.0.20 is out now",
    action: "update",
  });
});

test.each([
  ["waiting to be back", { online: false }, {}, false, "Updates to 0.0.19 when it's back online"],
  ["restarting", { online: false }, { state: "installing" }, true, "Restarting"],
  [
    "waiting on agents",
    {},
    {
      state: "waiting",
      busy: 2,
      ask: { id: "r", mode: "idle", version: "0.0.19", requestedAt: 1 },
    },
    true,
    "Waiting for 2 agents to finish",
  ],
  [
    "downloading",
    {},
    { state: "downloading", ask: { id: "r", mode: "idle", version: "0.0.19", requestedAt: 1 } },
    true,
    "Downloading",
  ],
  [
    "updated",
    {},
    { version: "0.0.19", available: null, state: "updated" },
    true,
    "Updated to 0.0.19",
  ],
] as const)("a run's row while %s", (_name, fields, update, sent, words) => {
  const run = start();
  const first = run.machines[0];
  if (!first) throw new Error("missing");
  const entry = { ...first, sent: sent ? 1 : null };
  const now = machine(entry.id, update, fields);
  expect(fleetRunLine(fleetRunState(run, entry, now, 2), entry, now).words).toBe(words);
});

test("a run is kept across a reload and dropped after seven days", () => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    removeItem: (key: string) => void data.delete(key),
  };
  const run = sentAll(start());
  saveFleetRun(storage, run);
  expect(loadFleetRun(storage, 6 * day)).toEqual(run);
  expect(loadFleetRun(storage, 8 * day)).toBeNull();
  expect(data.size).toBe(0);
  data.set("ace.fleet.updateRun", "{not json");
  expect(loadFleetRun(storage, 0)).toBeNull();
});

test("Fleet offers Update all, then counts the run down, then offers again once it's done", () => {
  expect(fleetUpdateHeadline(fleet, null, 0)).toEqual({
    title: "3 machines can update to 0.0.19",
    note: "Old laptop is offline, Deb box updates from its release page and this window can only read Kitchen Mac.",
    actions: ["all", "all-now"],
  });
  const run = sentAll(start());
  expect(fleetUpdateHeadline(fleet, run, 1)).toEqual({
    title: "0 of 4 updated · 1 when back online",
    note: "Deb box updates from its release page and this window can only read Kitchen Mac.",
    actions: [],
  });
  const done = online(
    updatedFleet(["Build server", "Windows PC", "This Mac", "Old laptop"]),
  ).filter((entry) => !["Deb box", "Kitchen Mac", "Busy box"].includes(entry.id));
  expect(fleetUpdateHeadline(done, run, 2)?.title).toBe("All 4 machines updated to 0.0.19");
});

test("a machine row shows its place in the run, and its own state outside one", () => {
  const run = sentAll(start());
  const pc = fleet.find((entry) => entry.id === "Windows PC");
  const deb = fleet.find((entry) => entry.id === "Deb box");
  if (!pc || !deb) throw new Error("missing");
  expect(fleetMachineLine(pc, run, 1)?.words).toBe("Asked to update");
  expect(fleetMachineLine(pc, null, 1)).toMatchObject({
    words: "Update available · 0.0.19",
    action: "update",
  });
  expect(fleetMachineLine(deb, run, 1)?.words).toBe(
    "Update available · 0.0.19 · from its release page",
  );
});
