import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { runProtectedAttempt, type ProtectedAttempt } from "./locked-use-attempt.ts";
import { connectLockedUse, openLockedUseConnection } from "./locked-use-connection.ts";
import { systemScheduler } from "./runtime.ts";
import {
  endAttempt,
  fakeLockedUseService,
  fakeLockedUseToken,
  fakeStatus,
  type FakeLockedUseService,
} from "./testing/fake-locked-use-service.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const failingWork = async () => {
  throw new Error("app_not_found");
};
const slow = async (signal: AbortSignal) => {
  await new Promise((resolve) => setTimeout(resolve, 250));
  return signal.aborted ? "aborted" : "the outline";
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "ace-lu-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  const service = await fakeLockedUseService(join(dir, "s.sock"));
  cleanups.push(() => service.close());
  let next = 0;
  const connection = await openLockedUseConnection(await connectLockedUse(service.path), {
    nextId: () => `r${++next}`,
    scheduler: systemScheduler,
    requestTimeoutMs: 200,
    token: fakeLockedUseToken,
  });
  cleanups.push(() => connection.close());
  const ran: string[] = [];
  const work = async (signal: AbortSignal) => {
    ran.push(service.status.phase);
    if (service.status.phase !== "working") throw new Error("work ran outside working");
    return signal.aborted ? "aborted" : "the outline";
  };
  const run = <T>(overrides: Partial<ProtectedAttempt<T>> & Pick<ProtectedAttempt<T>, "work">) =>
    runProtectedAttempt(connection, {
      threadID: "thread-1",
      turnID: "run-1",
      agentProcessIDs: [4242],
      attemptID: "attempt-1",
      optIn: true,
      scheduler: systemScheduler,
      readyTimeoutMs: 300,
      relockTimeoutMs: 300,
      ...overrides,
    });
  const types = () => service.requests.map((request) => request.type);
  return { service, connection, ran, work, run, types };
}

/** begin is accepted and covering starts, then the script takes over. */
function coverThen(service: FakeLockedUseService, next: () => void) {
  service.handle("begin", (fake, request) => {
    fake.status = {
      ...fake.status,
      phase: "covering",
      attemptID: request.scope?.attemptID ?? null,
    };
    fake.reply(request);
    next();
  });
}

it("a locked attempt runs the work only while working, then finishes and waits for relock", async () => {
  const { service, ran, work, run, types } = await setup();
  const result = await run({ work });
  expect(result).toBe("the outline");
  expect(ran).toEqual(["working"]);
  expect(types()).toEqual(["status", "enable", "begin", "finish"]);
  const begin = service.requests[2];
  expect(begin?.scope).toEqual({
    userID: 501,
    sessionID: 100003,
    threadID: "thread-1",
    turnID: "run-1",
    attemptID: "attempt-1",
  });
  expect(begin?.agentProcessIDs).toEqual([4242]);
  expect(service.status).toMatchObject({ phase: "ready", session: "locked" });
});

it("a refused begin (not locked) fails closed without running the work", async () => {
  const { service, ran, work, run, types } = await setup();
  service.handle("begin", (fake, request) =>
    fake.reply(request, { code: "not_locked", message: "The Mac is not locked." }),
  );
  await expect(run({ work })).rejects.toMatchObject({ code: "locked_use_not_locked" });
  expect(ran).toEqual([]);
  expect(types()).toEqual(["status", "enable", "begin"]);
});

it("an unlock_request_failed event stops the attempt before any work and cancels it", async () => {
  const { service, ran, work, run } = await setup();
  coverThen(service, () => {
    service.publish({ phase: "authorizing" });
    service.send({
      type: "error",
      code: "unlock_request_failed",
      message: "The unlock request was refused (status -60005). The Mac stays locked.",
      attemptID: "attempt-1",
    });
  });
  const error = await run({ work }).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: "locked_use_unlock_request_failed" });
  expect(String(error)).toContain("Nothing ran in the app");
  expect((await service.received("cancel")).attemptID).toBe("attempt-1");
  // A late working report for the dead attempt still runs nothing.
  service.publish({ phase: "working", attemptID: "attempt-1" });
  await settle();
  expect(ran).toEqual([]);
});

it("the person touching the Mac while it is covered reports a takeover, and nothing runs", async () => {
  const { service, ran, work, run } = await setup();
  coverThen(service, () => endAttempt(service, undefined, "localInput"));
  const error = await run({ work }).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: "person_took_over" });
  expect(String(error)).toContain("The person took over the Mac");
  expect(ran).toEqual([]);
});

it("a takeover while the work runs aborts the work and reports the takeover, not its result", async () => {
  const { service, run } = await setup();
  const seen: boolean[] = [];
  const work = async (signal: AbortSignal) => {
    endAttempt(service, undefined, "localInput");
    await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
    seen.push(signal.aborted);
    return "should not be returned";
  };
  await expect(run({ work })).rejects.toMatchObject({ code: "person_took_over" });
  expect(seen).toEqual([true]);
});

it("an attempt that never reaches working times out, is cancelled, and never runs", async () => {
  const { service, ran, work, run } = await setup();
  coverThen(service, () => service.publish({ phase: "authorizing" }));
  await expect(run({ work, readyTimeoutMs: 100 })).rejects.toMatchObject({
    code: "locked_use_timeout",
  });
  expect((await service.received("cancel")).attemptID).toBe("attempt-1");
  service.publish({ phase: "working", attemptID: "attempt-1" });
  await settle();
  expect(ran).toEqual([]);
});

it("losing the service connection mid-attempt fails closed without running the work", async () => {
  const { service, connection, ran, work, run } = await setup();
  coverThen(service, () => service.dropClients());
  await expect(run({ work })).rejects.toMatchObject({ code: "locked_use_connection_lost" });
  expect(ran).toEqual([]);
  expect(connection.closed).toBe(true);
  // The closed connection can start no other attempt.
  await expect(run({ work, attemptID: "attempt-2" })).rejects.toMatchObject({
    code: "locked_use_unavailable",
  });
  expect(ran).toEqual([]);
});

it("a bad frame length from the service closes the connection and stops the attempt", async () => {
  const { service, connection, ran, work, run } = await setup();
  coverThen(service, () => service.sendBytes(new Uint8Array([0, 0, 0, 0])));
  await expect(run({ work })).rejects.toMatchObject({ code: "locked_use_connection_lost" });
  expect(connection.closed).toBe(true);
  expect(ran).toEqual([]);
});

it("an unverified installation never begins an attempt", async () => {
  const { service, ran, work, run, types } = await setup();
  service.status = fakeStatus({
    phase: "ready",
    installation: { ...fakeStatus().installation, guardianLinked: false, verified: false },
  });
  await expect(run({ work })).rejects.toMatchObject({ code: "locked_use_not_installed" });
  expect(types()).toEqual(["status"]);
  expect(ran).toEqual([]);
});

it("a step that fails inside the interval still relocks first, then reports its own error", async () => {
  const { service, run, types } = await setup();
  await expect(run({ work: failingWork })).rejects.toThrow("app_not_found");
  expect(types()).toEqual(["status", "enable", "begin", "finish"]);
  expect(service.status).toMatchObject({ phase: "ready", session: "locked" });
});

it("a relock the service never confirms is an error, not a success", async () => {
  const { service, run, work } = await setup();
  service.handle("finish", (fake, request) => {
    fake.reply(request);
    fake.publish({ phase: "relocking" });
  });
  await expect(run({ work, relockTimeoutMs: 100 })).rejects.toMatchObject({
    code: "locked_use_relock_unconfirmed",
  });
});

it("a relock read together with working never starts the work, and reports why it stopped", async () => {
  const { service, ran, work, run } = await setup();
  coverThen(service, () => {
    service.publish({ phase: "working", session: "unlocked" });
    service.publish({ phase: "relocking" });
    setTimeout(() => endAttempt(service, undefined, "expired"), 50);
  });
  const error = await run({ work }).catch((caught: unknown) => caught);
  expect(error).toMatchObject({ code: "locked_use_expired" });
  expect(ran).toEqual([]);
});

it("work that outlasts the unlock deadline still finishes: the deadline stops at working", async () => {
  const { run, types } = await setup();
  await expect(run({ work: slow, readyTimeoutMs: 100 })).resolves.toBe("the outline");
  expect(types()).toEqual(["status", "enable", "begin", "finish"]);
});

it("a finish the service refuses reports a relock problem, never that nothing ran", async () => {
  const { service, ran, work, run } = await setup();
  service.handle("finish", (fake, request) =>
    fake.reply(request, { code: "relock_failed", message: "The lock was not confirmed." }),
  );
  const error = await run({ work }).catch((caught: unknown) => caught);
  expect(ran).toEqual(["working"]);
  expect(error).toMatchObject({ code: "locked_use_relock_failed" });
  expect(String(error)).toContain("The step ran");
  expect(String(error)).not.toContain("Nothing ran");
});

it("a begin that gets no reply in time is cancelled, so the service can't hold the Mac unlocked", async () => {
  const { service, ran, work, run } = await setup();
  service.handle("begin", () => {});
  const error = await run({ work }).catch((caught: unknown) => caught);
  expect(String(error)).toContain("Nothing ran");
  expect((await service.received("cancel")).attemptID).toBe("attempt-1");
  expect(ran).toEqual([]);
});

it("with the setting off, enable carries no opt-in: the service refuses and nothing runs", async () => {
  const { service, ran, work, run, types } = await setup();
  await expect(run({ work, optIn: false })).rejects.toMatchObject({
    code: "locked_use_not_enabled",
  });
  expect(types()).toEqual(["status", "enable"]);
  expect(ran).toEqual([]);
  expect(service.status).toMatchObject({ phase: "disabled", session: "locked" });
});

it("a begin without the opt-in is refused as not enabled, even with the service ready", async () => {
  const { service, ran, work, run, types } = await setup();
  service.status = fakeStatus({ phase: "ready" });
  await expect(run({ work, optIn: false })).rejects.toMatchObject({
    code: "locked_use_not_enabled",
  });
  expect(types()).toEqual(["status", "begin"]);
  expect(ran).toEqual([]);
  expect(service.status).toMatchObject({ phase: "disabled", session: "locked" });
});
