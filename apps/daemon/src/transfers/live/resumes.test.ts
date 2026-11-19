import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ThreadStatus } from "@ace/protocol";
import { Store } from "../../store.ts";
import { LiveResumes, type LiveResumePorts } from "./resumes.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

/** A machine whose engine refuses sends while `full`, keeping receipts as real ones do. */
async function machine() {
  const root = await mkdtemp(join(tmpdir(), "ace-resume-"));
  const path = join(root, "store.sqlite");
  let store = new Store(path);
  const opened: LiveResumes[] = [];
  const closeAll = async () => {
    for (const resumes of opened.splice(0)) await resumes.close();
  };
  cleanups.push(async () => {
    await closeAll();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const receipts = new Map<string, boolean>();
  const sent: { key: string; text: string }[] = [];
  const world = { full: true, clock: 0, status: { state: "done" } as ThreadStatus };
  const ports = (): LiveResumePorts => ({
    store,
    // A command id answered once answers the same way again, as command receipts do.
    send: (_thread, key, text) => {
      const replay = receipts.get(key);
      const ok = replay ?? !world.full;
      receipts.set(key, ok);
      if (!ok) throw new Error("engine_capacity_exceeded");
      if (replay === undefined) sent.push({ key, text });
    },
    status: () => world.status,
    now: () => world.clock,
    sleep: (_ms, signal) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      }),
    log: () => {},
  });
  return {
    world,
    sent,
    resumes: () => {
      const resumes = new LiveResumes(ports());
      opened.push(resumes);
      return resumes;
    },
    async restart() {
      await closeAll();
      store.close();
      store = new Store(path);
    },
  };
}

describe("telling an agent its failed move left it here (ADR 0191)", () => {
  it("sends the message once the full engine has room, under a fresh id per attempt", async () => {
    const m = await machine();
    const resumes = m.resumes();
    resumes.owe("t", "x", "Moving this thread to Studio didn't work. Carry on.");
    resumes.drain();
    m.world.clock += 1_000;
    resumes.drain();
    expect(m.sent).toEqual([]);
    // Another thread finished: a slot is free.
    m.world.full = false;
    m.world.clock += 60_000;
    resumes.drain();
    expect(m.sent).toHaveLength(1);
    expect(m.sent[0]?.text).toContain("didn't work");
    // Delivered once: nothing more is owed.
    m.world.clock += 60_000;
    resumes.drain();
    expect(m.sent).toHaveLength(1);
  });

  it("still owes it after a restart, and sends it then", async () => {
    const m = await machine();
    m.resumes().owe("t", "x", "Carry on.");
    m.resumes().drain();
    await m.restart();
    m.world.full = false;
    m.world.clock += 60_000;
    m.resumes().drain();
    expect(m.sent.map((entry) => entry.text)).toEqual(["Carry on."]);
  });

  it("drops it once the thread carried on by itself", async () => {
    const m = await machine();
    const resumes = m.resumes();
    resumes.owe("t", "x", "Carry on.");
    resumes.drain();
    m.world.status = { state: "working", agents: 1 };
    m.world.full = false;
    m.world.clock += 60_000;
    resumes.drain();
    expect(m.sent).toEqual([]);
  });

  it("keeps it owed while the thread waits or is paused, and sends it once it is at rest", async () => {
    const m = await machine();
    m.world.full = false;
    m.world.status = { state: "waiting", on: "queue" };
    const resumes = m.resumes();
    resumes.owe("t", "x", "Carry on.");
    resumes.drain();
    m.world.status = { state: "limited" };
    m.world.clock += 10_000;
    resumes.drain();
    expect(m.sent).toEqual([]);
    m.world.status = { state: "done" };
    m.world.clock += 10_000;
    resumes.drain();
    expect(m.sent.map((entry) => entry.text)).toEqual(["Carry on."]);
  });
});
