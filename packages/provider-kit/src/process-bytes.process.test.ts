import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { z } from "zod";
import { spawnBytes } from "./process-bytes.ts";
import { guardGroupSignals } from "./process-owner.ts";

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ESRCH") return false;
    throw error;
  }
}

// The helper's parent exits at once, so taskkill /T from the leader can no longer find it; it
// keeps the leader's stdout open, so only ending the leader's Job lets the stream close.
const helper = "process.stdout.write(process.pid + '\\n'); setInterval(() => {}, 1000);";
const middle = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(helper)}], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] }).unref();`;
const leader = (exit: boolean) =>
  `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(middle)}], { stdio: ['ignore', 'inherit', 'ignore'] }).once('exit', () => { process.stdout.write('parent gone\\n'); ${exit ? "process.exit(0);" : ""} }); setInterval(() => {}, 1000);`;

test.runIf(process.platform === "win32").each(["a stop", "a normal exit"] as const)(
  "on Windows a byte stream settles after %s while a detached helper holds stdout, and the helper is gone",
  async (mode) => {
    const root = await mkdtemp(join(tmpdir(), "ace-bytes-helper-"));
    let pid: number | undefined;
    try {
      const draining = Promise.withResolvers<() => void>();
      const child = spawnBytes({
        command: process.execPath,
        args: ["-e", leader(mode === "a normal exit")],
        cwd: root,
        env: { ...process.env },
        // Held so the helper's pid is read before the leader's drain window passes.
        scheduleDrain(callback) {
          draining.resolve(callback);
          return () => {};
        },
      });
      // Both the helper's pid and its parent's exit are known before the stream is ended.
      let text = "";
      const known = Promise.withResolvers<void>();
      child.stdout.on("data", (chunk) => {
        text += String(chunk);
        if (/^\d+$/m.test(text) && text.includes("parent gone")) known.resolve();
      });
      await known.promise;
      pid = z.coerce
        .number()
        .int()
        .positive()
        .parse(/^(\d+)$/m.exec(text)?.[1]);
      let settled: Promise<unknown>;
      if (mode === "a stop") settled = child.stop();
      else {
        // The leader has exited; let its drain window pass.
        (await draining.promise)();
        settled = child.exited;
      }
      const outcome = await Promise.race([
        settled.then(() => "settled"),
        delay(10_000).then(() => "still open"),
      ]);
      expect(outcome).toBe("settled");
      // Checked at once: settling before the Job is empty would leave the helper alive here.
      expect(isRunning(pid)).toBe(false);
    } finally {
      if (pid !== undefined && isRunning(pid)) {
        process.kill(pid, "SIGKILL");
        while (isRunning(pid)) await delay(25);
      }
      await rm(root, { recursive: true, force: true, maxRetries: 20 });
    }
  },
);

// A detached helper (its own session and group) keeps stdout open past the leader's exit, so
// the stream is still draining once the leader's group has emptied and its number is free.
const heldOpen = `require('node:child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 500)'], { detached: true, stdio: ['ignore', 'inherit', 'ignore'] }).unref();`;

test.runIf(process.platform !== "win32")(
  "once its leader is reaped and its group is empty, a byte process never signals that group number",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "ace-bytes-reaped-"));
    // Every group signal passes the guard first; this one only records and lets nothing through,
    // so the test never signals a group that may already belong to someone else.
    const asked: number[] = [];
    const unguard = guardGroupSignals((group) => {
      asked.push(group);
      return [];
    });
    try {
      const draining = Promise.withResolvers<() => void>();
      const child = spawnBytes({
        command: process.execPath,
        args: ["-e", heldOpen],
        cwd: root,
        env: { ...process.env },
        scheduleDrain(callback) {
          draining.resolve(callback);
          return () => {};
        },
      });
      child.stdout.resume();
      child.stderr.resume();
      // The drain is scheduled from the exit listener: the leader has been reaped by now.
      const drain = await draining.promise;
      drain();
      await child.exited;
      expect(asked).toEqual([]);
    } finally {
      unguard();
      await rm(root, { recursive: true, force: true, maxRetries: 20 });
    }
  },
);
