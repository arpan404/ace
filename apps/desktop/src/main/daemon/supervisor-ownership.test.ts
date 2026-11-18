import { describe, expect, it } from "vitest";
import { foundDaemon, type LockOwner, type OwnershipRecord } from "./ownership.ts";
import { DaemonSupervisor, type DaemonProcess } from "./supervisor.ts";
import { machine } from "./supervisor-test-support.ts";

/**
 * One computer across several launches of the app: the fake machine's daemons, the home's lock
 * (the pid and run id of the daemon holding it) and the app's ownership record, which outlive
 * any one launch's supervisor.
 */
function computer() {
  const m = machine();
  const home: { lock?: LockOwner | undefined; record?: OwnershipRecord | undefined } = {};
  const pids = new Map<DaemonProcess, number>();
  let nextPid = 100;
  const spawnFake = m.ports.spawn;
  if (!spawnFake) throw new Error("The fake machine spawns daemons");
  m.ports.spawn = (launch) => {
    const child = spawnFake(launch);
    const pid = nextPid++;
    pids.set(child, pid);
    // The daemon takes the home's lock as it starts.
    home.lock = { pid, id: `run-${pid}` };
    return child;
  };
  /** One launch of the app at `version`, with this computer's ownership ports. */
  const launch = (
    version: string,
    options: ConstructorParameters<typeof DaemonSupervisor>[1] = {},
  ) =>
    new DaemonSupervisor(
      {
        ...m.ports,
        claimOwned: async () => {
          const found = foundDaemon(home.record, home.lock, version);
          if (found.kind === "external") return undefined;
          const process = [...pids].find(([, pid]) => pid === found.pid)?.[0];
          if (!process) return undefined;
          return found.kind === "adopt"
            ? { process, replace: false, version }
            : { process, replace: true, version: found.version };
        },
        recordOwned: async (process) => {
          const pid = pids.get(process);
          if (pid === undefined || home.lock?.pid !== pid) return false;
          home.record = { pid, lockId: home.lock.id, version, startedAt: m.ports.now() };
          return true;
        },
      },
      options,
    );
  /** Start a launch and let the daemon it spawns answer. */
  const startWithOwnDaemon = async (supervisor: DaemonSupervisor) => {
    await supervisor.start();
    m.state.answering = true;
    await m.advance(500);
  };
  return { ...m, home, launch, startWithOwnDaemon };
}

describe("the daemon outlives the app that started it (ADR 0186)", () => {
  it("quit leaves the app-started daemon running and the next launch adopts it without spawning", async () => {
    const c = computer();
    const first = c.launch("1.0.0");
    await c.startWithOwnDaemon(first);
    expect(first.current()).toMatchObject({ state: "running", source: "app" });

    await first.release();
    expect(c.signals).toEqual([]);
    expect(c.children[0]?.alive).toBe(true);

    const second = c.launch("1.0.0");
    await second.start();
    await c.advance(0);
    expect(c.children).toHaveLength(1);
    expect(second.current()).toMatchObject({ state: "running", source: "app" });
    // Its own, as if it had started it: work in it counts for an update.
    c.state.blockers = 2;
    expect(await second.busy()).toBe(2);
  });

  it("quit ace completely stops the daemon an earlier launch left running", async () => {
    const c = computer();
    const first = c.launch("1.0.0");
    await c.startWithOwnDaemon(first);
    await first.release();
    const second = c.launch("1.0.0");
    await second.start();
    await c.advance(0);

    await second.stop();
    expect(c.signals).toEqual(["SIGTERM"]);
    expect(c.children[0]?.alive).toBe(false);
    expect(second.current().state).toBe("stopped");
  });

  it("an adopted daemon that stops answering is restarted, as one this launch started would be", async () => {
    const c = computer();
    const first = c.launch("1.0.0");
    await c.startWithOwnDaemon(first);
    await first.release();
    const second = c.launch("1.0.0", { healthIntervalMs: 1_000, healthTimeoutMs: 1_000 });
    await second.start();
    await c.advance(0);

    // Hung: it ignores SIGTERM too, so the stop escalates after its grace.
    c.state.healthy = false;
    await c.advance(30_000);
    expect(c.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(c.children[0]?.alive).toBe(false);
    expect(c.children).toHaveLength(2);
  });

  it("an app-owned daemon of another version is replaced on launch after drain", async () => {
    const c = computer();
    const first = c.launch("1.0.0");
    await c.startWithOwnDaemon(first);
    await first.release();
    c.state.blockers = 1;

    const second = c.launch("1.1.0");
    const starting = second.start();
    await c.advance(3_000);
    // New work waits while the old daemon's running work finishes; nothing is stopped yet.
    expect(c.state.updateHold).toBe(true);
    expect(c.children[0]?.alive).toBe(true);
    expect(second.current()).toMatchObject({ state: "starting", stage: "lock-wait" });

    c.state.blockers = 0;
    await c.advance(1_000);
    await starting;
    expect(c.signals).toEqual(["SIGTERM"]);
    expect(c.children[0]?.alive).toBe(false);
    expect(c.children).toHaveLength(2);
    c.state.answering = true;
    await c.advance(500);
    expect(second.current()).toMatchObject({ state: "running", source: "app" });
    expect(c.home.record).toMatchObject({ version: "1.1.0", pid: 101 });
  });

  it("an old daemon still busy at the drain's bound is stopped anyway: it never serves a newer app", async () => {
    const c = computer();
    const first = c.launch("1.0.0");
    await c.startWithOwnDaemon(first);
    await first.release();
    c.state.blockers = 1;

    const second = c.launch("1.1.0", { replaceDrainMs: 10_000 });
    const starting = second.start();
    await c.advance(9_000);
    expect(c.children[0]?.alive).toBe(true);
    await c.advance(2_000);
    await starting;
    expect(c.children[0]?.alive).toBe(false);
    expect(c.children).toHaveLength(2);
  });

  it("quitting while an old daemon drains leaves it on file as the old version, so the next launch replaces it", async () => {
    const c = computer();
    const first = c.launch("1.0.0");
    await c.startWithOwnDaemon(first);
    await first.release();
    c.state.blockers = 1;

    const second = c.launch("1.1.0");
    const starting = second.start();
    await c.advance(2_000);
    const quitting = second.release();
    // The drain notices at its next poll that the app is quitting.
    await c.advance(1_000);
    await Promise.all([quitting, starting]);
    expect(c.children[0]?.alive).toBe(true);
    expect(c.children).toHaveLength(1);
    expect(c.home.record).toMatchObject({ version: "1.0.0", pid: 100 });
  });

  it("a CLI daemon is never adopted as app-owned, even with an old record of the app's on file", async () => {
    const c = computer();
    const first = c.launch("1.0.0");
    await c.startWithOwnDaemon(first);
    await first.stop();
    // The CLI's daemon now holds the home, with a pid the app's daemon once had.
    c.state.external = true;
    c.state.answering = true;
    c.home.lock = { pid: 100, id: "cli-run" };

    const second = c.launch("1.1.0");
    await second.start();
    await c.advance(0);
    expect(second.current()).toMatchObject({ state: "running", source: "external" });
    const signalsBefore = c.signals.length;
    await second.stop();
    expect(c.signals).toHaveLength(signalsBefore);
  });

  it("a daemon that has not taken its home's lock when the app quits is stopped, not left unowned", async () => {
    const c = computer();
    const first = c.launch("1.0.0");
    await first.start();
    // Still opening its database: no lock yet, so nothing could tell later that it is the app's.
    c.home.lock = undefined;
    await first.release();
    expect(c.signals).toEqual(["SIGTERM"]);
    expect(c.children[0]?.alive).toBe(false);
  });
});

describe("whose a found daemon is", () => {
  const record: OwnershipRecord = { pid: 10, lockId: "run-a", version: "1.0.0", startedAt: 0 };
  it.each([
    ["no record", undefined, { pid: 10, id: "run-a" }, "1.0.0", { kind: "external" }],
    ["no lock", record, undefined, "1.0.0", { kind: "external" }],
    [
      "a reused pid in another run",
      record,
      { pid: 10, id: "run-b" },
      "1.0.0",
      { kind: "external" },
    ],
    ["another pid", record, { pid: 11, id: "run-a" }, "1.0.0", { kind: "external" }],
    [
      "the app's run, same version",
      record,
      { pid: 10, id: "run-a" },
      "1.0.0",
      { kind: "adopt", pid: 10 },
    ],
    [
      "the app's run, other version",
      record,
      { pid: 10, id: "run-a" },
      "1.1.0",
      { kind: "replace", pid: 10, version: "1.0.0" },
    ],
  ] as const)("%s", (_name, saved, lock, version, expected) => {
    expect(foundDaemon(saved, lock, version)).toEqual(expected);
  });
});
