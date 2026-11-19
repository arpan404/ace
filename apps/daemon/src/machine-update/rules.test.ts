import { expect, test } from "vitest";
import type { MachineUpdateAsk } from "@ace/protocol";
import {
  machineStatus,
  nextStep,
  requiredScope,
  settleInstall,
  startRefusal,
  type InstallerFacts,
  type Installing,
} from "./rules.ts";

const offer = (over: Partial<InstallerFacts> = {}): InstallerFacts => ({
  available: "0.0.19",
  releaseUrl: "https://github.com/arpan404/ace/releases/tag/v0.0.19",
  blocked: null,
  phase: "available",
  percent: null,
  error: null,
  checkedAt: 1,
  downloadsFirst: false,
  ...over,
});
const ask = (mode: "idle" | "now", version = "0.0.19"): MachineUpdateAsk => ({
  id: "ask-1",
  mode,
  version,
  requestedAt: 1,
});
const installing: Installing = { from: "0.0.18", to: "0.0.19", mode: "idle", at: 1 };

test.each([
  ["no request does nothing", { ask: null, facts: offer(), busy: 0 }, { kind: "none" }],
  [
    "when idle waits while agents work",
    { ask: ask("idle"), facts: offer(), busy: 2 },
    { kind: "none" },
  ],
  [
    "when idle installs once nothing works",
    { ask: ask("idle"), facts: offer(), busy: 0 },
    { kind: "install", mode: "idle" },
  ],
  [
    "now installs while agents work",
    { ask: ask("now"), facts: offer(), busy: 3 },
    { kind: "install", mode: "now" },
  ],
  [
    "the app downloads before anything installs",
    { ask: ask("now"), facts: offer({ downloadsFirst: true }), busy: 0 },
    { kind: "download" },
  ],
  [
    "a download under way is left to finish",
    { ask: ask("now"), facts: offer({ downloadsFirst: true, phase: "downloading" }), busy: 0 },
    { kind: "none" },
  ],
  [
    "a downloaded release installs when idle",
    { ask: ask("idle"), facts: offer({ downloadsFirst: true, phase: "ready" }), busy: 0 },
    { kind: "install", mode: "idle" },
  ],
  [
    "a closed app keeps the request until it opens",
    { ask: ask("idle"), facts: offer({ available: null, blocked: "app-closed" }), busy: 0 },
    { kind: "none" },
  ],
  [
    "no offer yet keeps waiting",
    { ask: ask("idle"), facts: offer({ available: null, phase: "none" }), busy: 0 },
    { kind: "none" },
  ],
])("%s", (_name, input, expected) => {
  expect(nextStep({ installing: null, ...input })).toEqual(expected);
});

test("a request for a release that's no longer the one on offer expires with why", () => {
  const step = nextStep({
    ask: ask("idle"),
    facts: offer({ available: "0.0.20" }),
    busy: 0,
    installing: null,
  });
  expect(step).toEqual({ kind: "expire", error: expect.stringContaining("0.0.20 is out now") });
});

test("an install under way is never started twice", () => {
  expect(nextStep({ ask: ask("now"), facts: offer(), busy: 0, installing })).toEqual({
    kind: "none",
  });
  expect(
    nextStep({ ask: ask("now"), facts: offer({ phase: "installing" }), busy: 0, installing: null }),
  ).toEqual({
    kind: "none",
  });
});

test.each([
  ["accepted when idle", { mode: "idle", version: "0.0.19" }, offer(), 4, undefined],
  [
    "now with every working agent confirmed",
    { mode: "now", version: "0.0.19", agents: 2 },
    offer(),
    2,
    undefined,
  ],
  [
    "now with an agent started since the confirm",
    { mode: "now", version: "0.0.19", agents: 1 },
    offer(),
    2,
    "confirm",
  ],
  [
    "now without a confirm while agents work",
    { mode: "now", version: "0.0.19" },
    offer(),
    1,
    "confirm",
  ],
  ["a release the person didn't see", { mode: "idle", version: "0.0.18" }, offer(), 0, "stale"],
  ["nothing on offer", { mode: "idle", version: "0.0.19" }, offer({ available: null }), 0, "stale"],
  [
    "a deb or tar.gz install",
    { mode: "idle", version: "0.0.19" },
    offer({ blocked: "release-page" }),
    0,
    "blocked",
  ],
  [
    "a closed desktop app",
    { mode: "now", version: "0.0.19", agents: 0 },
    offer({ blocked: "app-closed" }),
    0,
    "blocked",
  ],
  ["a start without a version", { mode: "idle" }, offer(), 0, "invalid"],
] as const)("start: %s", (_name, request, facts, busy, expected) => {
  expect(startRefusal({ request, facts, busy })).toBe(expected);
});

test.each([
  ["status", "read"],
  ["check", "admin"],
  ["start", "admin"],
  ["cancel", "admin"],
] as const)("%s needs %s scope", (operation, scope) => {
  expect(requiredScope(operation)).toBe(scope);
});

test.each([
  [
    "the new version running means it worked",
    "0.0.19",
    undefined,
    { ok: true, error: null },
    false,
  ],
  [
    "the old version running says the updater's reason",
    "0.0.18",
    { ok: false, error: "The new version didn't start, so ace went back to 0.0.18." },
    { ok: false, error: "The new version didn't start, so ace went back to 0.0.18." },
    false,
  ],
  [
    "the old version with no word from the updater still says what runs",
    "0.0.18",
    undefined,
    { ok: false, error: "The update to 0.0.19 didn't finish. ace 0.0.18 is still running." },
    false,
  ],
  [
    "agents outlasting the drain keep an update when idle waiting",
    "0.0.18",
    { ok: false, error: "Agents were still working.", busy: true },
    { ok: false },
    true,
  ],
] as const)("after a restart, %s", (_name, running, outcome, last, retry) => {
  const settled = settleInstall({ installing, running, outcome, at: 9 });
  expect(settled.last).toMatchObject({ from: "0.0.18", to: "0.0.19", at: 9, ...last });
  expect(settled.retry).toBe(retry);
});

const status = (over: Partial<Parameters<typeof machineStatus>[0]>) =>
  machineStatus({
    version: "0.0.18",
    platform: "linux",
    arch: "x64",
    install: "standalone",
    facts: offer(),
    ask: null,
    installing: null,
    last: null,
    busy: 0,
    ...over,
  });

test.each([
  ["an offer reads available", {}, "available"],
  ["nothing newer reads none", { facts: offer({ available: null, phase: "none" }) }, "none"],
  ["when idle with agents working reads waiting", { ask: ask("idle"), busy: 2 }, "waiting"],
  [
    "a download reads downloading",
    { ask: ask("now"), facts: offer({ phase: "downloading", percent: 40 }) },
    "downloading",
  ],
  ["an install under way reads installing", { ask: ask("now"), installing }, "installing"],
  [
    "the version it updated to reads updated",
    {
      version: "0.0.19",
      facts: offer({ available: null, phase: "none" }),
      last: { from: "0.0.18", to: "0.0.19", ok: true, error: null, at: 2 },
    },
    "updated",
  ],
  [
    "a failure with the release still on offer reads failed",
    { last: { from: "0.0.18", to: "0.0.19", ok: false, error: "No disk space.", at: 2 } },
    "failed",
  ],
] as const)("%s", (_name, over, state) => {
  expect(status(over).state).toBe(state);
});

test("a failed update says why and keeps reporting the old version", () => {
  const update = status({
    last: { from: "0.0.18", to: "0.0.19", ok: false, error: "No disk space.", at: 2 },
  });
  expect(update).toMatchObject({
    version: "0.0.18",
    state: "failed",
    error: "No disk space.",
    available: "0.0.19",
  });
});
