import { MachineUpdate } from "@ace/protocol";
import { expect, test } from "vitest";
import { fleetUpdatePlan, pickedUpdatePlan, updateChoices } from "./fleet-update-plan.ts";
import { newFleetRun } from "./fleet-update-run.ts";
import type { UpdateMachine } from "./machine-update-words.ts";

const machine = (
  id: string,
  update: Partial<MachineUpdate> = {},
  fields: Partial<UpdateMachine> = {},
): UpdateMachine => ({
  id,
  name: id,
  primary: false,
  online: true,
  access: "admin",
  update: MachineUpdate.parse({
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
    ...update,
  }),
  ...fields,
});

const fleet = [
  machine("This Mac", { busy: 1 }, { primary: true }),
  machine("Build server", { busy: 2 }),
  machine("Windows PC", { available: "0.0.20" }),
  machine("Old laptop", {}, { online: false }),
  machine("Deb box", { blocked: "release-page" }),
];
const plan = fleetUpdatePlan(fleet);

test("the machines a person can pick are every one Update all asks, plus offline ones that update once back", () => {
  expect(updateChoices(plan).map((choice) => [choice.id, choice.offline])).toEqual([
    ["Build server", false],
    ["Windows PC", false],
    ["This Mac", false],
    ["Old laptop", true],
  ]);
});

test("updating the picked machines asks only them, this window's machine still last", () => {
  const picked = pickedUpdatePlan(plan, new Set(["This Mac", "Build server"]));
  const run = newFleetRun({ id: "run", plan: picked, mode: "idle", now: 0 });
  expect(run.machines.map((entry) => entry.id)).toEqual(["Build server", "This Mac"]);
  expect(picked.version).toBe("0.0.19");
});

test("an offline pick waits for its machine when updating on idle, and is left out when updating now", () => {
  const picked = pickedUpdatePlan(plan, new Set(["Old laptop", "Windows PC"]));
  expect(
    newFleetRun({ id: "run", plan: picked, mode: "idle", now: 0 }).machines.map((m) => m.id),
  ).toEqual(["Windows PC", "Old laptop"]);
  expect(
    newFleetRun({ id: "run", plan: picked, mode: "now", now: 0 }).machines.map((m) => m.id),
  ).toEqual(["Windows PC"]);
  expect(picked.version).toBe("0.0.20");
});

test("picking machines on different releases names no single version", () => {
  expect(pickedUpdatePlan(plan, new Set(["Windows PC", "Build server"])).version).toBeNull();
});
