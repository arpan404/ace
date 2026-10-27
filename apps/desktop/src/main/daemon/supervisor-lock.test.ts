import { exitCodes } from "@ace/service/exit-codes";
import { describe, expect, it } from "vitest";
import { DaemonSupervisor, lockHeldMessage } from "./supervisor.ts";
import { local, machine, track } from "./supervisor-test-support.ts";

const lockHeld = exitCodes["lock-held"];

describe("daemon supervisor and another daemon's lock", () => {
  it("a daemon refused by another daemon's lock waits for that daemon instead of giving up", async () => {
    const m = machine();
    const supervisor = new DaemonSupervisor(m.ports);
    const seen = track(supervisor);
    const client = supervisor.reachable();
    let failed = false;
    client.catch(() => (failed = true));
    void supervisor.start();
    await m.advance(0);
    // The other daemon (left by an earlier app) is still in a long startup for a minute.
    for (let i = 0; i < 10; i++) {
      m.children.at(-1)?.die(lockHeld);
      await m.advance(6_000);
    }
    expect(supervisor.current()).toMatchObject({ state: "starting", cause: "lock-held" });
    expect(seen.some((status) => status.state === "failed")).toBe(false);
    expect(failed).toBe(false);

    m.state.external = true;
    m.state.answering = true;
    m.children.at(-1)?.die(lockHeld);
    await m.advance(6_000);

    await expect(client).resolves.toEqual(local);
    expect(supervisor.current()).toMatchObject({ state: "running", source: "external" });
    expect(supervisor.current().cause).toBeUndefined();
    expect(m.log.some((entry) => entry.message.includes("gave up"))).toBe(false);
  });

  it("starts its own daemon once the other daemon lets go of the lock", async () => {
    const m = machine();
    const supervisor = new DaemonSupervisor(m.ports);
    void supervisor.start();
    await m.advance(0);
    // The other daemon is shutting down: refused three times, then the lock is free.
    for (let i = 0; i < 3; i++) {
      m.children.at(-1)?.die(lockHeld);
      await m.advance(6_000);
    }
    const ours = m.children.at(-1);
    m.state.answering = true;
    await m.advance(1_000);

    expect(ours?.alive).toBe(true);
    expect(supervisor.current()).toMatchObject({ state: "running", source: "app", restarts: 0 });
    // Our own daemon, so quitting stops it.
    await supervisor.stop();
    expect(ours?.alive).toBe(false);
  });

  it("says it failed only once the other daemon keeps the lock past the bound", async () => {
    const m = machine();
    const supervisor = new DaemonSupervisor(m.ports, { lockWaitMs: 60_000, lockRetryMs: 5_000 });
    void supervisor.start();
    await m.advance(0);
    for (let elapsed = 0; elapsed <= 60_000; elapsed += 5_000) {
      expect(supervisor.current().state).not.toBe("failed");
      m.children.at(-1)?.die(lockHeld);
      await m.advance(5_000);
    }
    expect(supervisor.current()).toMatchObject({
      state: "failed",
      cause: "lock-held",
      message: lockHeldMessage,
    });
    const spawned = m.children.length;
    await m.advance(60_000);
    expect(m.children.length).toBe(spawned);
  });

  it("a real crash after waiting on the lock still restarts with backoff and gives up", async () => {
    const m = machine();
    const supervisor = new DaemonSupervisor(m.ports, { maxRestarts: 2 });
    void supervisor.start();
    await m.advance(0);
    m.children.at(-1)?.die(lockHeld);
    await m.advance(6_000);
    for (let i = 0; i < 3; i++) {
      m.children.at(-1)?.die(1);
      await m.advance(10_000);
    }
    expect(supervisor.current().state).toBe("failed");
    expect(supervisor.current().cause).toBeUndefined();
  });

  it("quitting while it waits on another daemon's lock starts nothing more", async () => {
    const m = machine();
    const supervisor = new DaemonSupervisor(m.ports);
    void supervisor.start();
    await m.advance(0);
    m.children.at(-1)?.die(lockHeld);
    await m.advance(100);
    const spawned = m.children.length;
    const stopped = supervisor.stop();
    // The look for the other daemon notices the quit at its next poll.
    await m.advance(60_000);
    await stopped;
    expect(m.children.length).toBe(spawned);
    expect(supervisor.current().state).toBe("stopped");
  });
});
