import { MachineUpdate } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  fleetUpdateNowConfirm,
  machineSoftware,
  machineUpdateLine,
  updateNowConfirm,
  updateRefusal,
  type UpdateMachine,
} from "./machine-update-words.ts";

const status = (fields: Partial<MachineUpdate> = {}): MachineUpdate =>
  MachineUpdate.parse({
    version: "0.0.18",
    platform: "darwin",
    arch: "arm64",
    install: "desktop",
    state: "available",
    available: "0.0.19",
    releaseUrl: "https://github.com/arpan404/ace/releases/tag/v0.0.19",
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
  update: Partial<MachineUpdate> | undefined,
  fields: Partial<UpdateMachine> = {},
) => ({
  id: "build",
  name: "Build server",
  primary: false,
  online: true,
  access: "admin" as const,
  update: update === undefined ? undefined : status(update),
  ...fields,
});

const ask = { id: "a", mode: "idle", version: "0.0.19", requestedAt: 1 };

test.each([
  ["an offer", {}, {}, "Update available · 0.0.19", "update"],
  [
    "waiting for two agents",
    { state: "waiting", busy: 2, ask },
    {},
    "Waiting for 2 agents to finish",
    null,
  ],
  [
    "waiting for one agent",
    { state: "waiting", busy: 1, ask },
    {},
    "Waiting for 1 agent to finish",
    null,
  ],
  [
    "downloading with progress",
    { state: "downloading", percent: 41.6, ask },
    {},
    "Downloading · 42%",
    null,
  ],
  ["downloading without progress", { state: "downloading", ask }, {}, "Downloading", null],
  ["restarting", { state: "installing", ask }, {}, "Restarting", null],
  ["a failure", { state: "failed", error: "Disk full." }, {}, "Failed: Disk full", "retry"],
  [
    "a release-page install",
    { blocked: "release-page" },
    {},
    "Update available · 0.0.19 · from its release page",
    null,
  ],
  [
    "an app that's closed",
    { blocked: "app-closed" },
    {},
    "Update available · 0.0.19 · open the ace app there to update",
    null,
  ],
  ["a read-only machine", {}, { access: "read" }, "Update available · 0.0.19", null],
  ["a newer daemon's state while asked", { state: "verifying", ask }, {}, "Updating", null],
  [
    "a newer daemon's block reason",
    { blocked: "managed-by-mdm" },
    {},
    "Update available · 0.0.19",
    null,
  ],
] as const)("a fleet row shows %s", (_name, update, fields, words, action) => {
  expect(machineUpdateLine(machine(update, fields))).toMatchObject({ words, action });
});

test("a fleet row says nothing when the machine is up to date or never reported", () => {
  expect(machineUpdateLine(machine({ state: "none", available: null }))).toBeNull();
  expect(machineUpdateLine(machine(undefined))).toBeNull();
});

test.each([
  ["an offer", {}, {}, "ace 0.0.18. 0.0.19 is available.", null, ["idle", "now"], null],
  [
    "up to date",
    { state: "none", available: null, version: "0.0.19" },
    {},
    "ace 0.0.19. Up to date.",
    null,
    ["check"],
    null,
  ],
  [
    "waiting",
    { state: "waiting", busy: 2, ask },
    {},
    "ace 0.0.18. 0.0.19 is available.",
    "Waiting for 2 agents to finish",
    ["now", "cancel"],
    null,
  ],
  [
    "downloading",
    { state: "downloading", percent: 40, ask },
    {},
    "ace 0.0.18. 0.0.19 is available.",
    "Downloading · 40%",
    ["now", "cancel"],
    null,
  ],
  [
    "installing",
    { state: "installing", ask },
    {},
    "ace 0.0.18. 0.0.19 is available.",
    "Restarting",
    [],
    null,
  ],
  [
    "updated",
    {
      version: "0.0.19",
      state: "updated",
      available: null,
      last: { from: "0.0.18", to: "0.0.19", ok: true, error: null, at: 2 },
    },
    {},
    "ace 0.0.19. Up to date.",
    "Updated to 0.0.19",
    ["check"],
    null,
  ],
  [
    "failed",
    { state: "failed", error: "The download was cut off." },
    {},
    "ace 0.0.18. 0.0.19 is available.",
    "Failed: The download was cut off",
    ["retry", "now"],
    null,
  ],
  [
    "release-page",
    { blocked: "release-page", install: "standalone" },
    {},
    "ace 0.0.18. 0.0.19 is available.",
    null,
    [],
    null,
  ],
  [
    "app-closed",
    { blocked: "app-closed" },
    {},
    "ace 0.0.18. 0.0.19 is available.",
    null,
    [],
    "Open the ace app on it to update.",
  ],
  [
    "read-only",
    {},
    { access: "read" },
    "ace 0.0.18. 0.0.19 is available.",
    null,
    [],
    "This window can only read this machine. Pair it again as Administrator to update it.",
  ],
] as const)("a machine page shows %s", (_name, update, fields, line, progress, actions, note) => {
  expect(machineSoftware(machine(update, fields))).toMatchObject({ line, progress, actions, note });
});

test("a release-page install links to the release instead of offering Update", () => {
  expect(machineSoftware(machine({ blocked: "release-page" })).link).toEqual({
    words: "Update from the release page",
    url: "https://github.com/arpan404/ace/releases/tag/v0.0.19",
  });
});

test("Update now asks how many agents stop and says they continue", () => {
  expect(updateNowConfirm({ name: "Build server", version: "0.0.19", busy: 2 }).body).toBe(
    "2 agents are working there. They stop while ace restarts to 0.0.19 and continue after it.",
  );
  expect(updateNowConfirm({ name: "Build server", version: "0.0.19", busy: 0 }).body).toBe(
    "Nothing is working there. ace restarts to 0.0.19.",
  );
});

test("Update all now lists the agents working on each machine", () => {
  const confirm = fleetUpdateNowConfirm([
    { name: "Build server", busy: 2 },
    { name: "Studio", busy: 0 },
    { name: "This Mac", busy: 1 },
  ]);
  expect(confirm.title).toBe("Update 3 machines now?");
  expect(confirm.body).toBe(
    "3 agents are working: 2 on Build server and 1 on This Mac. They stop while their machine restarts and continue after it.",
  );
});

test.each([
  [
    "forbidden",
    undefined,
    "This window can only read Studio. Pair it again as Administrator to update it.",
  ],
  ["confirm", { busy: 3 }, "3 agents are working on Studio now. Try again to confirm."],
  ["stale", undefined, "A newer release is out for Studio. Try again."],
  ["something-new", undefined, "Studio didn't start the update."],
] as const)("a %s refusal reads as words", (code, update, words) => {
  expect(updateRefusal(code, "Studio", update ? status(update) : undefined)).toBe(words);
});
