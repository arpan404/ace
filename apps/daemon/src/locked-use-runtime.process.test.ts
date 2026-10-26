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

async function until(done: () => boolean) {
  for (let tries = 0; tries < 200 && !done(); tries++)
    await new Promise((resolve) => setTimeout(resolve, 10));
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `sessions[n]` is the Mac's session as the n-th started service first reports it. */
async function runtime(options: { drainTimeoutMs?: number; sessions?: string[] } = {}) {
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
    ...(options.drainTimeoutMs ? { drainTimeoutMs: options.drainTimeoutMs } : {}),
    spawnService: (_command, args) => {
      const session = options.sessions?.[started.length];
      const extra = session ? ["--fake-session", session] : [];
      const child = spawn(process.execPath, [fakeService, ...args, ...extra], {
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

/** A protected run whose work kills the service mid-work; resolves to its error. */
function dieMidWork(owner: LockedUseRuntime, started: { child: ChildProcess }[]) {
  return owner
    .runProtected(
      { threadID: "thread-1", turnID: "run-1" },
      [process.pid],
      async (signal) => {
        started[0]?.child.kill("SIGKILL");
        await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
        return "must not be returned";
      },
      undefined,
      true,
    )
    .catch((error: unknown) => error);
}

it("a protected run never begins while an unprotected computer request is still in flight", async () => {
  const { owner, started } = await runtime();
  const helper = Promise.withResolvers<string>();
  const order: string[] = [];
  const unprotected = owner
    .runUnprotected(() =>
      helper.promise.catch((error: unknown) => {
        order.push("unprotected settled");
        throw error;
      }),
    )
    .catch((error: unknown) => error);
  const run = owner.runProtected(
    { threadID: "thread-1", turnID: "run-1" },
    [process.pid],
    async () => {
      order.push("work");
      return "done";
    },
    undefined,
    true,
  );
  await wait(150);
  // Nothing was asked of the service yet, so the Mac was never unlocked under the request.
  expect(started).toEqual([]);
  expect(order).toEqual([]);
  expect(owner.intervalActive()).toBe(true);
  // Settling with an error counts the same as a reply.
  helper.reject(new Error("app_not_found"));
  expect(await unprotected).toMatchObject({ message: "app_not_found" });
  await expect(run).resolves.toBe("done");
  expect(order).toEqual(["unprotected settled", "work"]);
});

it("a protected run is refused, and the service never asked, when an unprotected request won't settle", async () => {
  const { owner, started } = await runtime({ drainTimeoutMs: 100 });
  const helper = Promise.withResolvers<void>();
  const unprotected = owner.runUnprotected(() => helper.promise);
  const ran: string[] = [];
  const failed = await owner
    .runProtected(
      { threadID: "thread-1", turnID: "run-1" },
      [process.pid],
      async () => {
        ran.push("work");
        return "done";
      },
      undefined,
      true,
    )
    .catch((error: unknown) => error);
  expect(failed).toMatchObject({ code: "locked_use_busy" });
  expect(ran).toEqual([]);
  expect(started).toEqual([]);
  expect(owner.intervalActive()).toBe(false);
  helper.resolve();
  await unprotected;
});

it("the service dying mid-work keeps the interval active until a fresh status shows the Mac locked", async () => {
  const { owner, started } = await runtime();
  expect(await dieMidWork(owner, started)).toMatchObject({ code: "locked_use_connection_lost" });
  // The connection is gone, but the Mac may still be unlocked: other calls stay refused.
  expect(owner.status).toBeUndefined();
  expect(owner.intervalActive()).toBe(true);
  // Asking reaches a restarted service, which reports the Mac locked again.
  await until(() => !owner.intervalActive());
  expect(owner.intervalActive()).toBe(false);
  expect(owner.status).toMatchObject({ session: "locked" });
  expect(started).toHaveLength(2);
});

it("after the service dies mid-work, a fresh status from an unlocked Mac keeps the interval active", async () => {
  const { owner, started } = await runtime({ sessions: ["locked", "unlocked"] });
  expect(await dieMidWork(owner, started)).toMatchObject({ code: "locked_use_connection_lost" });
  await expect(owner.refresh()).resolves.toMatchObject({ phase: "disabled", session: "unlocked" });
  expect(owner.intervalActive()).toBe(true);
});
