import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { ComputerError } from "./client.ts";
import { computerWorld, manualScheduler, type WorldOptions } from "./testing/world.ts";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function world(options: WorldOptions = {}) {
  const made = await computerWorld(options);
  cleanups.push(made.close);
  return made;
}

async function marker(name: string) {
  const dir = await mkdtemp(join(tmpdir(), "ace-computer-marker-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return join(dir, name);
}

/** Short deadlines and grace, so a stuck app costs the test well under a second or two. */
const quick = { deadlineMs: (op: string) => (op === "act" ? 800 : 10_000), graceMs: 300 };

it("an app that never answers does not delay another app's reply", async () => {
  const { call } = await world({ client: quick });
  let stuckSettled = false;
  const stuck = call("screen_act", { app: "Stuck", actions: [{ type: "key", key: "Escape" }] });
  void stuck.then(() => (stuckSettled = true));
  const look = await call("screen_state", { app: "Calculator" });
  expect(look.text).toContain("6 text 0");
  expect(stuckSettled).toBe(false);
  expect((await stuck).text).toContain("did not respond in time");
});

it("an overdue app's helper is replaced; other apps keep theirs", async () => {
  const { call, children, exited } = await world({ client: quick });
  await call("screen_state", { app: "Calculator" });
  const before = children.length;
  const stuck = await call("screen_act", {
    app: "Stuck",
    actions: [{ type: "key", key: "Escape" }],
  });
  expect(stuck.result.isError).toBe(true);
  expect(stuck.text).toContain("did not respond in time");
  // Only the stuck app's helper was started for it, and it is gone now.
  expect(children.length).toBe(before + 1);
  await exited(children.at(-1));
  expect((await call("screen_state", { app: "Calculator" })).text).toContain(
    "No change since your last look.",
  );
  expect(children.length).toBe(before + 1);
});

it("an app that hung once times out, and the next call to it works on a fresh helper", async () => {
  const { call, children } = await world({
    env: { FAKE_HANG_ONCE: await marker("hung") },
    client: quick,
  });
  await call("screen_state", { app: "Calculator" });
  const started = children.length;
  const stuck = await call("screen_act", {
    app: "Calculator",
    actions: [{ type: "key", key: "Escape" }],
  });
  expect(stuck.text).toContain("did not respond in time");
  const after = await call("screen_act", {
    app: "Calculator",
    actions: [{ type: "key", key: "Escape" }],
  });
  expect(after.text).toContain("1. did key");
  expect(children.length).toBe(started + 1);
});

it("stopping an act cancels it in the helper, which reports the steps it finished", async () => {
  const { client, logged, children } = await world({ client: quick });
  const stop = new AbortController();
  const acting = client.request(
    "act",
    {
      app: "com.apple.calculator",
      actions: [
        { type: "key", key: "Escape" },
        { type: "wait", ms: 5_000 },
      ],
    },
    { signal: stop.signal },
  );
  await logged("act com.apple.calculator");
  stop.abort();
  const error = await acting.catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ComputerError);
  expect(error).toMatchObject({ code: "cancelled", result: { done: ["did key"] } });
  await logged("cancel");
  // The helper honoured the cancel, so it stays and answers the next request.
  await client.request("state", { app: "com.apple.calculator" });
  expect(children.length).toBe(1);
});

it("an agent that stops waiting frees the app for its next call", async () => {
  const { call, logged } = await world({ client: quick });
  const stop = new AbortController();
  const waiting = call(
    "screen_act",
    { app: "Calculator", actions: [{ type: "wait", ms: 5_000 }] },
    stop.signal,
  );
  await logged("act com.apple.calculator");
  stop.abort();
  expect((await waiting).text).toContain("cancelled");
  const next = await call("screen_act", {
    app: "Calculator",
    actions: [{ type: "key", key: "Escape" }],
  });
  expect(next.text).toContain("1. did key");
});

it("a helper that ignores a cancel is killed after the grace period; the next call works", async () => {
  const { client, logged, children, exited } = await world({
    env: { FAKE_HANG_ONCE: await marker("hung") },
    client: quick,
  });
  const stop = new AbortController();
  const acting = client.request(
    "act",
    { app: "com.apple.calculator", actions: [{ type: "key", key: "Escape" }] },
    { signal: stop.signal },
  );
  await logged("act com.apple.calculator");
  stop.abort();
  await expect(acting).rejects.toMatchObject({ code: "cancelled" });
  await exited(children[0]);
  const next = await client.request("act", {
    app: "com.apple.calculator",
    actions: [{ type: "key", key: "Escape" }],
  });
  expect(next).toMatchObject({ done: ["did key"] });
  expect(children.length).toBe(2);
});

it("a reply too large to accept fails its call at once with what to ask for instead", async () => {
  const { call } = await world({ client: { maxReplyBytes: 64 * 1024 } });
  const huge = await call("screen_state", { app: "Huge" });
  expect(huge.result.isError).toBe(true);
  expect(huge.text).toContain("larger than");
  expect(huge.text).toContain("use find");
  expect((await call("screen_state", { app: "Calculator" })).text).toContain("6 text 0");
});

it("helpers left idle exit, and the next call starts fresh ones", async () => {
  const clock = manualScheduler();
  const { call, children, exited } = await world({
    client: { scheduler: clock.scheduler, idleMs: 60_000 },
  });
  await call("screen_state", { app: "Calculator" });
  const started = children.length;
  clock.elapse(59_000);
  expect(children.every((child) => child.exitCode === null && child.signalCode === null)).toBe(
    true,
  );
  clock.elapse(1_000);
  await Promise.all(children.map(exited));
  expect((await call("screen_state", { app: "Calculator" })).text).toContain(
    "No change since your last look.",
  );
  expect(children.length).toBe(started + 1);
});

it("beyond the helper limit, the least recently used idle app's helper exits", async () => {
  const { call, children, exited } = await world({ client: { maxHelpers: 2 } });
  await call("screen_state", { app: "Calculator" });
  const calculator = children.at(-1);
  await call("screen_state", { app: "TextEdit" });
  await call("screen_state", { app: "Calculator" });
  const textEdit = children.at(-1);
  await call("screen_state", { app: "Frozen" });
  await exited(textEdit);
  expect(calculator?.exitCode).toBeNull();
  expect(calculator?.signalCode).toBeNull();
});
