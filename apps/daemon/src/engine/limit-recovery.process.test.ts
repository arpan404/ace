import { afterEach, expect, test } from "vitest";
import {
  fixture,
  cleanupRecovery,
  text,
  restart,
  resume,
  sends,
  replaceProvider,
} from "./recovery-test-support.ts";
import { scriptFrames, start, end } from "./test-support.ts";
import type { Fact } from "@ace/core";

afterEach(cleanupRecovery);
const limited: Fact = {
  type: "retry",
  agent: "root",
  on: "rate_limit",
  until: 4000,
  message: "Account allowance exhausted",
};
const quotaEnd: Fact = {
  type: "turn.ended",
  agent: "root",
  outcome: "failed",
  error: { kind: "quota", message: "Quota exhausted" },
};

async function limitedThread(options: Parameters<typeof fixture>[2] = {}) {
  const frames = scriptFrames();
  const h = await fixture(
    [{ on: "send", frames: [frames.frame(start, quotaEnd, limited)] }],
    frames,
    options,
  );
  const id = await h.create();
  h.command(
    { type: "thread.send", threadId: id, input: text("queued first") },
    "device",
    "first-followup",
  );
  h.command(
    { type: "thread.send", threadId: id, input: text("queued second") },
    "device",
    "second-followup",
  );
  await h.engine.flush();
  const replacement = replaceProvider(h, frames, [
    { on: "send", frames: [frames.frame(start, end)] },
    { on: "send", frames: [frames.frame(start, end)] },
    { on: "send", frames: [frames.frame(start, end)] },
  ]);
  return { h, id, frames, replacement };
}

test("limits stay distinct from failures after provider exit and manual resume preserves queued order", async () => {
  const { h, id, replacement } = await limitedThread();
  expect(h.store.getThread(id)?.status).toEqual({ state: "limited", until: 4000 });
  h.contexts[0]?.onExit({ deliberate: false, message: "quota exit" });
  await h.engine.flush();
  expect(h.store.getThread(id)?.status).toEqual({ state: "limited", until: 4000 });
  expect(h.engine.queue(id)).toMatchObject({ paused: true, reason: "limit" });
  expect(
    h.command({
      type: "thread.limit",
      threadId: id,
      expectedRevision: h.engine.queue(id).revision,
      action: "resume_now",
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.store.getThread(id)?.status.state).toBe("done");
  expect(
    Object.values(h.store.snapshotThread(id).runs).some((run) => run.trigger === "limit_resume"),
  ).toBe(true);
  expect(
    replacement.commands
      .filter((command) => command.type === "send")
      .slice(1)
      .map((command) => command.input),
  ).toEqual([text("queued first"), text("queued second")]);
});

test("resume at reset uses the account deadline and cannot fire a millisecond early", async () => {
  const { h, id, replacement } = await limitedThread({ recovery: { resetAt: () => 5000 } });
  expect(
    h.command({
      type: "thread.limit",
      threadId: id,
      expectedRevision: h.engine.queue(id).revision,
      action: "resume_at_reset",
    }).ok,
  ).toBe(true);
  expect(h.engine.queue(id).resumeAt).toBe(5000);
  h.clock.advance(4999);
  await h.engine.flush();
  expect(sends(replacement)).toHaveLength(0);
  h.clock.advance(5000);
  await h.engine.flush();
  expect(sends(replacement)).toHaveLength(3);
  h.clock.advance(6000);
  await h.engine.flush();
  expect(sends(replacement)).toHaveLength(3);
});

test("a persisted reset timer resumes a limited thread even when restart auto-continue is disabled", async () => {
  const { h, id, replacement } = await limitedThread({
    preferences: { limitPolicy: "resume_at_reset" },
    recovery: { resetAt: () => 5000 },
  });
  const recovered = await restart(h, {
    preferences: { continueAfterRestart: false },
    recovery: { resetAt: () => 5000 },
  });
  expect(recovered.queue(id).resumeAt).toBe(5000);
  h.clock.advance(4999);
  await recovered.flush();
  expect(sends(replacement)).toHaveLength(0);
  h.clock.advance(5000);
  await recovered.flush();
  expect(sends(replacement)).toHaveLength(3);
  expect(h.store.getThread(id)?.status.state).toBe("done");
});

test("snooze reaches its deadline without spending quota and leaves the queue available for manual resume", async () => {
  const { h, id, replacement } = await limitedThread({
    preferences: { limitPolicy: "snooze_until_reset" },
    recovery: { resetAt: () => 5000 },
  });
  expect(h.engine.queue(id)).toMatchObject({ paused: true, reason: "limit", resumeAt: 5000 });
  h.clock.advance(5000);
  await h.engine.flush();
  expect(sends(replacement)).toHaveLength(0);
  expect(h.engine.queue(id)).toMatchObject({ paused: true, reason: "manual", resumeAt: null });
  expect(h.engine.queue(id).messages.map((message) => message.id)).toEqual([
    "first-followup",
    "second-followup",
  ]);
  expect(resume(h, h.engine, id).ok).toBe(true);
  await h.engine.flush();
  expect(sends(replacement)).toHaveLength(3);
});

test("a resetless limit refuses a timed action and keeps every message", async () => {
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [frames.frame(start, quotaEnd)] }], frames);
  const id = await h.create();
  h.command({ type: "thread.send", threadId: id, input: text("saved") });
  await h.engine.flush();
  expect(
    h.command({
      type: "thread.limit",
      threadId: id,
      expectedRevision: h.engine.queue(id).revision,
      action: "resume_at_reset",
    }).error,
  ).toBe("reset_time_unknown");
  expect(h.engine.queue(id).messages[0]?.input).toEqual(text("saved"));
  expect(h.store.getThread(id)?.status.state).toBe("limited");
});

test("move to another account binds native continuation and following messages to the migrated session", async () => {
  const { h, id, replacement } = await limitedThread({
    recovery: {
      migrate: async (_id, target) => {
        if (target !== "account-b") throw new Error("Unavailable target");
        return { nativeSessionId: "migrated-native", instanceId: target };
      },
    },
  });
  expect(
    h.command({
      type: "thread.limit",
      threadId: id,
      expectedRevision: h.engine.queue(id).revision,
      action: "migrate_now",
      instanceId: "account-b",
    }).ok,
  ).toBe(true);
  await h.engine.flush();
  expect(h.contexts.at(-1)).toMatchObject({
    instanceId: "account-b",
    resume: { nativeSessionId: "migrated-native" },
  });
  expect(h.engine.sessionMetadata(id)).toMatchObject({
    instanceId: "account-b",
    nativeSessionId: "migrated-native",
  });
  expect(sends(replacement)).toHaveLength(3);
  expect(h.store.getThread(id)?.status.state).toBe("done");
});

test("migration refusal retains the source binding and exposes an actionable held queue", async () => {
  const { h, id, replacement } = await limitedThread({
    recovery: {
      migrate: async () => {
        throw new Error("Writer exclusion unavailable");
      },
    },
  });
  const metadata = h.engine.sessionMetadata(id);
  h.command({
    type: "thread.limit",
    threadId: id,
    expectedRevision: h.engine.queue(id).revision,
    action: "migrate_now",
    instanceId: "account-b",
  });
  await h.engine.flush();
  expect(h.engine.sessionMetadata(id)).toEqual(metadata);
  expect(h.engine.queue(id)).toMatchObject({ paused: true, reason: "manual" });
  expect(h.engine.queue(id).messages).toHaveLength(2);
  expect(sends(replacement)).toHaveLength(0);
  expect(
    Object.values(h.store.snapshotThread(id).items).some(
      (item) => item.type === "notice" && item.text.includes("Writer exclusion unavailable"),
    ),
  ).toBe(true);
});

test("pausing while native resume is opening fences the continuation and later sends", async () => {
  const { h, id, replacement } = await limitedThread();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const adapter = h.registry.get("codex").adapter;
  h.registry.register(
    {
      ...adapter,
      async openSession(ctx) {
        entered.resolve();
        await release.promise;
        return adapter.openSession(ctx);
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  h.command({ type: "thread.resume", threadId: id, expectedRevision: h.engine.queue(id).revision });
  await entered.promise;
  expect(
    h.command({ type: "queue.pause", threadId: id, expectedRevision: h.engine.queue(id).revision })
      .ok,
  ).toBe(true);
  release.resolve();
  await h.engine.flush();
  expect(sends(replacement)).toHaveLength(0);
  expect(h.engine.queue(id)).toMatchObject({ paused: true, reason: "manual" });
  expect(h.engine.queue(id).messages).toHaveLength(2);
});

test("an account resetless blocker overrides a provider retry estimate", async () => {
  const { h, id, replacement } = await limitedThread({ recovery: { resetAt: () => null } });
  expect(
    h.command({
      type: "thread.limit",
      threadId: id,
      expectedRevision: h.engine.queue(id).revision,
      action: "resume_at_reset",
    }).error,
  ).toBe("reset_time_unknown");
  h.clock.advance(5000);
  await h.engine.flush();
  expect(sends(replacement)).toHaveLength(0);
  expect(h.engine.queue(id).messages).toHaveLength(2);
});

test("the default limit policy reloads layered settings when the active thread hits its limit", async () => {
  let policy: "manual" | "resume_at_reset" = "manual";
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [frames.frame(start)] }], frames, {
    recovery: {
      resetAt: () => 5000,
      preferences: async () => ({
        followUpBehavior: "queue",
        continueAfterRestart: false,
        limitPolicy: policy,
      }),
    },
  });
  await h.engine.ready();
  const id = await h.create();
  policy = "resume_at_reset";
  h.contexts[0]?.onFrame(frames.frame(quotaEnd, limited));
  await h.engine.flush();
  expect(h.engine.queue(id)).toMatchObject({ paused: true, resumeAt: 5000 });
});
