import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { LockedUseRuntime } from "./locked-use-runtime.ts";

const fakeService = fileURLToPath(import.meta.resolve("@ace/screen/testing/locked-use-service"));

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const exited = (child: ChildProcess) =>
  new Promise<void>((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once("exit", () => resolve());
  });

async function untilReady(owner: LockedUseRuntime) {
  for (let tries = 0; tries < 100 && owner.status?.phase !== "ready"; tries++)
    await new Promise((resolve) => setTimeout(resolve, 10));
}

async function runtime() {
  const dir = await mkdtemp(join(tmpdir(), "ace-lur-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const started: { args: readonly string[]; child: ChildProcess }[] = [];
  let next = 0;
  let attempts = 0;
  let starts = 0;
  const owner = new LockedUseRuntime({
    helper: async () => "ace-screen-helper",
    socketPath: join(dir, "s.sock"),
    nextId: () => `r${++next}`,
    attemptId: () => `attempt-${++attempts}`,
    scheduler: { after: (ms, run) => clearTimeout.bind(undefined, setTimeout(run, ms)) },
    // Each start's token differs, so a restarted service proves it got its own.
    randomBytes: (size) => new Uint8Array(size).fill(++starts),
    spawnService: (_command, args) => {
      const child = spawn(process.execPath, [fakeService, ...args], {
        stdio: ["pipe", "ignore", "ignore"],
      });
      started.push({ args, child });
      return child;
    },
  });
  cleanups.push(async () => {
    owner.close();
    await Promise.all(started.map(({ child }) => exited(child)));
  });
  return { owner, started, socketPath: join(dir, "s.sock") };
}

it("the service starts only when first asked, then reports a verified locked Mac", async () => {
  const { owner, started, socketPath } = await runtime();
  expect(started).toEqual([]);
  expect(owner.verifiedAndLocked()).toBe(false);
  const status = await owner.refresh();
  expect(status).toMatchObject({ phase: "disabled", session: "locked" });
  expect(started.map(({ args }) => args)).toEqual([["--locked-use", "--socket", socketPath]]);
  expect(owner.verifiedAndLocked()).toBe(true);
});

it("a protected run returns the work's result after the service relocks", async () => {
  const { owner } = await runtime();
  const result = await owner.runProtected(
    { threadID: "thread-1", turnID: "run-1" },
    [process.pid],
    async (signal) => (signal.aborted ? "aborted" : "done"),
    undefined,
    true,
  );
  expect(result).toBe("done");
  // The relock is confirmed; the service's own `ready` report may follow a moment later.
  expect(owner.intervalActive()).toBe(false);
  await untilReady(owner);
  expect(owner.status).toMatchObject({ phase: "ready", session: "locked" });
});

it("the service dying mid-work stops the attempt, and the next use starts a new service", async () => {
  const { owner, started } = await runtime();
  const aborted: boolean[] = [];
  const failed = await owner
    .runProtected(
      { threadID: "thread-1", turnID: "run-1" },
      [process.pid],
      async (signal) => {
        started[0]?.child.kill("SIGKILL");
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        aborted.push(signal.aborted);
        return "must not be returned";
      },
      undefined,
      true,
    )
    .catch((error: unknown) => error);
  expect(failed).toMatchObject({ code: "locked_use_connection_lost" });
  expect(aborted).toEqual([true]);
  expect(owner.verifiedAndLocked()).toBe(false);
  await expect(owner.refresh()).resolves.toMatchObject({ session: "locked" });
  expect(started).toHaveLength(2);
});

it("an interval counts as active from the protected run's start until it relocks", async () => {
  const { owner } = await runtime();
  expect(owner.intervalActive()).toBe(false);
  const seen: boolean[] = [];
  const run = owner.runProtected(
    { threadID: "thread-1", turnID: "run-1" },
    [process.pid],
    async () => {
      seen.push(owner.intervalActive());
      return "done";
    },
    undefined,
    true,
  );
  expect(owner.intervalActive()).toBe(true);
  await expect(run).resolves.toBe("done");
  expect(seen).toEqual([true]);
  expect(owner.intervalActive()).toBe(false);
});

it("cancelling active runs stops the work, and the interval ends only once the Mac relocks", async () => {
  const { owner } = await runtime();
  const aborted: boolean[] = [];
  const failed = owner
    .runProtected(
      { threadID: "thread-1", turnID: "run-1" },
      [process.pid],
      async (signal) => {
        owner.cancelActive();
        if (!signal.aborted)
          await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        aborted.push(signal.aborted);
        return "must not be returned";
      },
      undefined,
      true,
    )
    .catch((error: unknown) => error);
  expect(await failed).toMatchObject({ code: "cancelled" });
  expect(aborted).toEqual([true]);
  // Cancelled, but not yet relocked: other calls still may not use the Mac.
  expect(owner.intervalActive()).toBe(true);
  await untilReady(owner);
  expect(owner.status).toMatchObject({ phase: "ready", session: "locked" });
  expect(owner.intervalActive()).toBe(false);
});
