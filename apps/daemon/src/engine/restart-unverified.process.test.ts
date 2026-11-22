import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { backup } from "node:sqlite";
import { afterEach, expect, test } from "vitest";
import { processIdentity } from "@ace/provider-kit/process-identity";
import { ProcessInventory } from "@ace/provider-kit/process-inventory";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { Engine, Store } from "@ace/daemon";
import { verifyRecovery } from "../process-recovery.ts";
import type { ThreadId } from "@ace/protocol";
import {
  cleanupRecovery,
  crashCopy,
  fixture,
  replaceProvider,
  sends,
  dispatch,
  text,
} from "./recovery-test-support.ts";
import { end, scriptFrames, start } from "./test-support.ts";

afterEach(cleanupRecovery);

function notices(store: Store, id: ThreadId) {
  return Object.values(store.snapshotThread(id).items).flatMap((item) =>
    item.type === "notice" ? [{ code: item.code, text: item.text }] : [],
  );
}

test.runIf(process.platform === "win32")(
  "Windows: after a crash whose processes could not all be verified gone, the cut-short turn is neither reported stopped nor continued",
  async () => {
    const frames = scriptFrames();
    const h = await fixture([{ on: "send", frames: [frames.frame(start)] }], frames);
    const id = await h.create();
    await h.engine.flush();
    const replacement = replaceProvider(h, frames, [
      { on: "send", frames: [frames.frame(start, end)] },
    ]);

    const recovered = await crashCopy(h, { previousProcessesUnverified: true });
    h.clock.advance(h.clock.now() + 60_000);
    await recovered.engine.flush();

    // Starting the work again could run it twice beside a survivor.
    expect(sends(replacement)).toEqual([]);
    expect(notices(recovered.store, id)).toContainEqual({
      code: "recovery_uncertain",
      text: "Some processes from the previous run may still be running",
    });
    expect(notices(recovered.store, id).map((notice) => notice.code)).not.toContain(
      "restart_interrupted",
    );
  },
);

/**
 * A real process group the last run left: its leader exited, a child in it runs on, recorded in a
 * real inventory as the crashed daemon's. Startup's proof that the last run's processes are gone
 * can never be had for it.
 */
async function survivingGroup() {
  const dir = mkdtempSync(join(tmpdir(), "ace-surviving-group-"));
  const child = "setInterval(()=>{},1000)";
  const leader = spawn(
    process.execPath,
    [
      "-e",
      `const c=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});console.log(c.pid);c.unref();`,
    ],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  const childPid = Number(
    await new Promise<string>((resolve) =>
      leader.stdout?.once("data", (data: Buffer) => resolve(String(data).trim())),
    ),
  );
  await new Promise((resolve) => leader.once("exit", resolve));
  const path = join(dir, "processes.sqlite");
  new ProcessInventory(path).close();
  const db = new DatabaseSync(path);
  db.prepare("INSERT INTO processes VALUES (?,?)").run(
    leader.pid ?? 0,
    JSON.stringify({
      pid: leader.pid,
      start: "1",
      uid: processIdentity(process.pid)?.uid,
      group: leader.pid,
      ownerPid: leader.pid,
      ownerStart: "1",
      name: "crashed-shell",
      createdAt: 0,
    }),
  );
  db.close();
  const inventory = new ProcessInventory(path);
  return {
    inventory,
    /** The surviving child ends, so the group is gone. */
    end: () => {
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        /* gone */
      }
    },
    alive: () => {
      try {
        process.kill(childPid, 0);
        return true;
      } catch {
        return false;
      }
    },
    async [Symbol.asyncDispose]() {
      inventory.close();
      try {
        process.kill(childPid, "SIGKILL");
      } catch {
        /* gone */
      }
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test.skipIf(process.platform === "win32")(
  "a turn cut short while a group of the last run still runs stays working until startup's proof settles, and is never continued beside it",
  async () => {
    await using group = await survivingGroup();
    const frames = scriptFrames();
    const h = await fixture([{ on: "send", frames: [frames.frame(start)] }], frames);
    const id = await h.create();
    await h.engine.flush();
    const replacement = replaceProvider(h, frames, [
      { on: "send", frames: [frames.frame(start, end)] },
    ]);
    const path = join(h.home, "crash.sqlite");
    await backup(
      h.store.atomic((db) => db),
      path,
    );
    const store = new Store(path);
    const proof = Promise.withResolvers<boolean>();
    const engine = new Engine(store, {
      registry: h.registry,
      clock: h.clock,
      previousProcessesVerified: proof.promise,
      // The background check, against the same real group.
      recheckPreviousProcesses: () =>
        verifyRecovery(group.inventory, 50).then((recovery) => recovery.verified),
    });
    try {
      // While the proof is pending the turn is untouched: still working, nothing continued.
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(store.getThread(id)?.status.state).toBe("working");
      expect(sends(replacement)).toEqual([]);
      const verified = await verifyRecovery(group.inventory, 300);
      expect(verified.verified).toBe(false);
      expect(group.alive()).toBe(true);
      proof.resolve(verified.verified);
      h.clock.advance(h.clock.now() + 60_000);
      await engine.flush();
      expect(sends(replacement)).toEqual([]);
      const said = notices(store, id);
      expect(said).toContainEqual({
        code: "recovery_uncertain",
        text: "Some processes from the previous run may still be running",
      });
      expect(said.map((notice) => notice.code)).not.toContain("restart_interrupted");
      // Never left reading as working: it needs the person.
      expect(store.getThread(id)?.status.state).toBe("waiting");
      // The person's next message waits while the old work may still run, even after a check.
      dispatch(store, engine, {
        type: "thread.send",
        threadId: id,
        delivery: "queue",
        input: text("next step"),
      });
      await engine.flush();
      h.clock.advance(h.clock.now() + 6_000);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await engine.flush();
      expect(sends(replacement)).toEqual([]);
      // Once the group is gone, a later check lets the thread go and the message runs.
      group.end();
      await expect.poll(() => group.alive()).toBe(false);
      h.clock.advance(h.clock.now() + 20_000);
      await expect
        .poll(async () => {
          await engine.flush();
          return sends(replacement).length;
        })
        .toBe(1);
      expect(store.getThread(id)?.status.state).toBe("done");
    } finally {
      await engine.close();
      store.close();
    }
  },
);

test.skipIf(process.platform === "win32")(
  "the person can continue a held thread anyway, while the last run's group may still run",
  async () => {
    await using group = await survivingGroup();
    const frames = scriptFrames();
    const h = await fixture([{ on: "send", frames: [frames.frame(start)] }], frames);
    const id = await h.create();
    await h.engine.flush();
    const replacement = replaceProvider(h, frames, [
      { on: "send", frames: [frames.frame(start, end)] },
    ]);
    const path = join(h.home, "crash.sqlite");
    await backup(
      h.store.atomic((db) => db),
      path,
    );
    const store = new Store(path);
    const engine = new Engine(store, {
      registry: h.registry,
      clock: h.clock,
      previousProcessesVerified: verifyRecovery(group.inventory, 50).then((r) => r.verified),
    });
    try {
      await engine.flush();
      expect(store.getThread(id)?.status.state).toBe("waiting");
      dispatch(store, engine, {
        type: "thread.resume",
        threadId: id,
        expectedRevision: engine.queue(id).revision,
      });
      await engine.flush();
      expect(group.alive()).toBe(true);
      expect(sends(replacement)).toHaveLength(1);
      expect(store.getThread(id)?.status.state).toBe("done");
    } finally {
      await engine.close();
      store.close();
    }
  },
);
