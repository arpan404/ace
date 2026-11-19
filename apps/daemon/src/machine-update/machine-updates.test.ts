import { expect, test } from "vitest";
import type { AppUpdateReport } from "@ace/protocol";
import { AppUpdateBoard } from "../app-update-board.ts";
import { desktopInstaller } from "./desktop-installer.ts";
import type { Installer } from "./installer.ts";
import { MachineUpdates } from "./machine-updates.ts";
import { memoryRecord } from "./record.ts";
import { standaloneInstaller, type UpdaterPorts } from "./standalone-installer.ts";

function clock() {
  let time = 1_000;
  const timers: { at: number; run(): void; cancelled: boolean }[] = [];
  return {
    now: () => time,
    delay(run: () => void, ms: number) {
      const timer = { at: time + ms, run, cancelled: false };
      timers.push(timer);
      return () => (timer.cancelled = true);
    },
    advance(ms: number) {
      time += ms;
      for (const timer of timers.splice(0))
        if (timer.cancelled) continue;
        else if (timer.at <= time) timer.run();
        else timers.push(timer);
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A machine whose updater is a test double; `busy` is its working threads. */
function machine(
  options: {
    installer?: (c: ReturnType<typeof clock>) => Installer;
    version?: string;
    record?: ReturnType<typeof memoryRecord>;
  } = {},
) {
  const c = clock();
  const record = options.record ?? memoryRecord();
  const launches: string[] = [];
  let exit: (() => void) | undefined;
  const ports: UpdaterPorts = {
    check: async () => ({ version: "0.0.19" }),
    launch(mode) {
      launches.push(mode);
      return { exited: new Promise((resolve) => (exit = () => resolve(0))) };
    },
    takeOutcome: () => record.takeOutcome(),
  };
  const version = options.version ?? "0.0.18";
  const installer =
    options.installer?.(c) ?? standaloneInstaller({ version, ports, clock: c, log: () => {} });
  let busy = 0;
  const busyListeners = new Set<() => void>();
  let ids = 0;
  const updates = new MachineUpdates({
    installer,
    record,
    version,
    platform: "linux",
    arch: "x64",
    busy: () => busy,
    watchBusy(listener) {
      busyListeners.add(listener);
      return () => busyListeners.delete(listener);
    },
    now: c.now,
    id: () => `ask-${++ids}`,
    log: () => {},
  });
  return {
    clock: c,
    record,
    updates,
    launches,
    /** The updater ends while this daemon still runs (it failed). */
    updaterExits: () => exit?.(),
    setBusy(count: number) {
      busy = count;
      for (const listener of busyListeners) listener();
    },
  };
}

test("a standalone daemon checks its signed release feed shortly after starting", async () => {
  const m = machine();
  await m.updates.start();
  expect(m.updates.current()).toMatchObject({ state: "none", install: "standalone" });
  m.clock.advance(60_000);
  await settle();
  expect(m.updates.current()).toMatchObject({
    state: "available",
    available: "0.0.19",
    version: "0.0.18",
  });
});

test("an update when idle waits until the working thread finishes, then runs the updater", async () => {
  const m = machine();
  await m.updates.start();
  await m.updates.handle({ type: "machineUpdate.request", requestId: "c", operation: "check" });
  m.setBusy(1);
  const answer = await m.updates.handle({
    type: "machineUpdate.request",
    requestId: "s",
    operation: "start",
    mode: "idle",
    version: "0.0.19",
  });
  expect(answer).toMatchObject({ ok: true, update: { state: "waiting", busy: 1 } });
  expect(m.launches).toEqual([]);
  m.setBusy(0);
  await settle();
  expect(m.launches).toEqual(["idle"]);
  expect(m.updates.current().state).toBe("installing");
  // Recorded before it began, so the daemon after the restart knows what it was doing.
  expect((await m.record.load()).installing).toMatchObject({ from: "0.0.18", to: "0.0.19" });
});

test("now with working agents needs every one confirmed, then stops them through the updater", async () => {
  const m = machine();
  await m.updates.start();
  await m.updates.handle({ type: "machineUpdate.request", requestId: "c", operation: "check" });
  m.setBusy(2);
  const start = (agents: number) =>
    m.updates.handle({
      type: "machineUpdate.request",
      requestId: "s",
      operation: "start",
      mode: "now",
      version: "0.0.19",
      agents,
    });
  expect(await start(1)).toMatchObject({ ok: false, error: "confirm", update: { busy: 2 } });
  expect(m.launches).toEqual([]);
  expect(await start(2)).toMatchObject({ ok: true });
  await settle();
  expect(m.launches).toEqual(["now"]);
});

test("a failed update leaves the old version running and says why", async () => {
  const m = machine();
  await m.updates.start();
  await m.updates.handle({ type: "machineUpdate.request", requestId: "c", operation: "check" });
  await m.updates.handle({
    type: "machineUpdate.request",
    requestId: "s",
    operation: "start",
    mode: "idle",
    version: "0.0.19",
  });
  await settle();
  m.record.outcome = {
    ok: false,
    error: "The new version didn't start, so ace went back to 0.0.18.",
  };
  m.updaterExits();
  await settle();
  await settle();
  expect(m.updates.current()).toMatchObject({
    version: "0.0.18",
    state: "failed",
    ask: null,
    error: "The new version didn't start, so ace went back to 0.0.18.",
  });
});

test("the daemon that starts after the update reports the new version as updated", async () => {
  const before = machine();
  await before.updates.start();
  await before.updates.handle({
    type: "machineUpdate.request",
    requestId: "c",
    operation: "check",
  });
  await before.updates.handle({
    type: "machineUpdate.request",
    requestId: "s",
    operation: "start",
    mode: "idle",
    version: "0.0.19",
  });
  await settle();
  before.updates.close();
  const after = machine({ record: before.record, version: "0.0.19" });
  await after.updates.start();
  expect(after.updates.current()).toMatchObject({
    version: "0.0.19",
    state: "updated",
    ask: null,
    last: { from: "0.0.18", to: "0.0.19", ok: true },
  });
  expect(after.launches).toEqual([]);
});

test("a person's checks are spaced at least a minute apart", async () => {
  let checks = 0;
  const m = machine({
    installer: (c) =>
      standaloneInstaller({
        version: "0.0.18",
        clock: c,
        log: () => {},
        ports: {
          check: async () => (checks++, { version: "0.0.19" }),
          launch: () => ({ exited: new Promise(() => {}) }),
          takeOutcome: async () => undefined,
        },
      }),
  });
  await m.updates.start();
  const check = () =>
    m.updates.handle({ type: "machineUpdate.request", requestId: "c", operation: "check" });
  await check();
  await check();
  expect(checks).toBe(1);
  m.clock.advance(61_000);
  await check();
  expect(checks).toBe(2);
});

const report = (over: Partial<AppUpdateReport>): AppUpdateReport => ({
  version: "0.0.18",
  available: "0.0.19",
  downloaded: false,
  restartRequired: false,
  releaseUrl: "https://github.com/arpan404/ace/releases/tag/v0.0.19",
  state: "available",
  inPlace: true,
  ...over,
});

function desktop() {
  let board!: AppUpdateBoard;
  const m = machine({
    installer: (c) => {
      board = new AppUpdateBoard(c);
      return desktopInstaller(board, c);
    },
  });
  return { ...m, board };
}

test("the desktop app hears to download, then to install once idle, in the reply to its report", async () => {
  const m = desktop();
  await m.updates.start();
  m.board.set(report({}));
  m.setBusy(1);
  await m.updates.handle({
    type: "machineUpdate.request",
    requestId: "s",
    operation: "start",
    mode: "idle",
    version: "0.0.19",
  });
  expect(m.board.set(report({})).instruction).toMatchObject({
    action: "download",
    version: "0.0.19",
  });
  m.board.set(report({ state: "downloading", percent: 40 }));
  expect(m.updates.current()).toMatchObject({ state: "downloading", percent: 40 });
  // Downloaded while an agent works: it waits.
  const reply = m.board.set(
    report({ state: "downloaded", downloaded: true, restartRequired: true }),
  );
  expect(reply.instruction?.action).toBe("download");
  expect(m.updates.current().state).toBe("waiting");
  m.setBusy(0);
  await settle();
  expect(m.board.set(report({ state: "downloaded", downloaded: true })).instruction).toMatchObject({
    action: "install",
    mode: "idle",
  });
  m.board.set(report({ state: "installing", downloaded: true }));
  expect(m.updates.current().state).toBe("installing");
});

test("a desktop drain that meets new work keeps the update waiting for the next idle", async () => {
  const m = desktop();
  await m.updates.start();
  m.board.set(report({ state: "downloaded", downloaded: true }));
  await m.updates.handle({
    type: "machineUpdate.request",
    requestId: "s",
    operation: "start",
    mode: "idle",
    version: "0.0.19",
  });
  await settle();
  const first = m.board.instruction();
  m.board.set(report({ state: "installing", downloaded: true }));
  m.setBusy(1);
  m.board.set(
    report({ state: "downloaded", downloaded: true, error: "Agents are still working." }),
  );
  await settle();
  expect(m.updates.current()).toMatchObject({ state: "waiting", ask: { version: "0.0.19" } });
  m.setBusy(0);
  await settle();
  expect(m.board.instruction()).toMatchObject({ action: "install" });
  expect(m.board.instruction()?.id).not.toBe(first?.id);
});

test("an app that never picks up the install is reported, and the old version keeps running", async () => {
  const m = desktop();
  await m.updates.start();
  m.board.set(report({ state: "downloaded", downloaded: true }));
  await m.updates.handle({
    type: "machineUpdate.request",
    requestId: "s",
    operation: "start",
    mode: "now",
    version: "0.0.19",
    agents: 0,
  });
  await settle();
  // The app keeps reporting every 20 seconds but never starts installing.
  for (let elapsed = 0; elapsed < 90_000; elapsed += 20_000) {
    m.board.set(report({ state: "downloaded", downloaded: true }));
    m.clock.advance(20_000);
  }
  await settle();
  expect(m.updates.current()).toMatchObject({
    state: "failed",
    version: "0.0.18",
    error: "The ace app didn't start the update.",
  });
  expect(m.board.instruction()).toBeNull();
});

test.each([
  ["a closed app", null, "app-closed"],
  ["a deb or tar.gz install", report({ inPlace: false }), "release-page"],
  ["an app older than remote updates", { ...report({}), state: undefined }, "unknown"],
] as const)("%s can't be updated from elsewhere and says so", async (_name, sent, blocked) => {
  const m = desktop();
  await m.updates.start();
  if (sent) m.board.set(sent);
  expect(m.updates.current().blocked).toBe(blocked);
  const answer = await m.updates.handle({
    type: "machineUpdate.request",
    requestId: "s",
    operation: "start",
    mode: "idle",
    version: "0.0.19",
  });
  expect(answer.ok).toBe(false);
  expect(m.board.instruction()).toBeNull();
});
