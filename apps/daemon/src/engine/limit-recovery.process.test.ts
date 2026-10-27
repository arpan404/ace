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
import { InputRejected } from "@ace/engine-api";

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
  const h = await fixture([{ on: "send", frames: [frames.frame(start)] }], frames, options);
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
  // These inputs were queued during the turn, before its limit arrived.
  h.contexts[0]?.onFrame(frames.frame(quotaEnd, limited));
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
  expect(Object.values(h.store.snapshotThread(id).items)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        type: "message",
        synthetic: true,
        origin: expect.objectContaining({ kind: "limit_resume" }),
      }),
    ]),
  );
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

test("a reset deadline that fires while history publication holds the store retries instead of crashing", async () => {
  const failures: unknown[] = [];
  const { h, id, replacement } = await limitedThread({
    recovery: { resetAt: () => 5000, onError: (error) => failures.push(error) },
  });
  expect(
    h.command({
      type: "thread.limit",
      threadId: id,
      expectedRevision: h.engine.queue(id).revision,
      action: "resume_at_reset",
    }).ok,
  ).toBe(true);
  h.store.setHistoryWriting(true);
  // A throw here would escape the timer callback and take the daemon process down.
  expect(() => h.clock.advance(5000)).not.toThrow();
  expect(failures).toHaveLength(1);
  h.store.setHistoryWriting(false);
  await h.engine.flush();
  expect(sends(replacement)).toHaveLength(0);
  expect(h.engine.queue(id).resumeAt).toBe(5000);
  h.clock.advance(6000);
  await h.engine.flush();
  expect(sends(replacement)).toHaveLength(3);
});

test("a persisted reset timer the person chose resumes a limited thread across a restart", async () => {
  const { h, id, replacement } = await limitedThread({
    preferences: { limitPolicy: "resume_at_reset" },
    recovery: { resetAt: () => 5000 },
  });
  const recovered = await restart(h, { recovery: { resetAt: () => 5000 } });
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

test("a resetless limit refuses a timed action, and the person's next message is sent, not held", async () => {
  const frames = scriptFrames();
  const h = await fixture(
    [
      { on: "send", frames: [frames.frame(start, quotaEnd)] },
      { on: "send", frames: [frames.frame(start, end)] },
    ],
    frames,
  );
  const id = await h.create();
  expect(h.store.getThread(id)?.status.state).toBe("limited");
  expect(
    h.command({
      type: "thread.limit",
      threadId: id,
      expectedRevision: h.engine.queue(id).revision,
      action: "resume_at_reset",
    }).error,
  ).toBe("reset_time_unknown");
  // Nothing says the limit still holds, so the next send is the go-ahead.
  h.command({ type: "thread.send", threadId: id, input: text("saved") });
  await h.engine.flush();
  expect(h.engine.queue(id)).toMatchObject({ paused: false, messages: [] });
  expect(h.store.getThread(id)?.status.state).toBe("done");
});

test("move to another account binds native continuation and following messages to the migrated session", async () => {
  const { h, id, replacement } = await limitedThread({
    account: "account-a",
    recovery: { moveTarget: (_id, requested) => requested ?? "account-b" },
    transitions: {
      applyPatch: async () => {},
      migrate: async (request) =>
        request.to === "account-b"
          ? {
              status: "migrated",
              nativeSessionId: "migrated-native",
              action: "resume",
              copiedFiles: 1,
            }
          : { status: "refused", reason: "Unavailable target" },
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
    account: "account-a",
    recovery: { moveTarget: (_id, requested) => requested ?? "account-b" },
    transitions: {
      applyPatch: async () => {},
      migrate: async () => ({ status: "refused", reason: "Writer exclusion unavailable" }),
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
      (item) =>
        item.type === "notice" &&
        item.title === "Couldn't resume after the limit" &&
        item.detail?.includes("Writer exclusion unavailable"),
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

test("an account limit with no reset overrides a provider retry estimate and never times a resume", async () => {
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
  // The provider's 4s estimate never sends anything; only the person or a fresh reading does.
  expect(sends(replacement)).toHaveLength(0);
});

test("the default limit policy reloads layered settings when the active thread hits its limit", async () => {
  let policy: "manual" | "resume_at_reset" = "manual";
  const frames = scriptFrames();
  const h = await fixture([{ on: "send", frames: [frames.frame(start)] }], frames, {
    recovery: {
      resetAt: () => 5000,
      preferences: async () => ({
        followUpBehavior: "queue",
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

test.each(["manual", "resume_at_reset", "snooze_until_reset"] as const)(
  "a fresh message retries a timed limit under %s and cancels its continuation",
  async (action) => {
    const { h, id, replacement } = await limitedThread();
    if (action !== "manual") {
      expect(
        h.command({
          type: "thread.limit",
          threadId: id,
          expectedRevision: h.engine.queue(id).revision,
          action,
        }).ok,
      ).toBe(true);
    }
    h.contexts[0]?.onExit({ deliberate: false, message: "quota exit" });
    await h.engine.flush();
    expect(h.command({ type: "thread.send", threadId: id, input: text("try again") }).ok).toBe(
      true,
    );
    await h.engine.flush();
    expect(sends(replacement).map((command) => command.input)).toEqual([
      text("queued first"),
      text("queued second"),
      text("try again"),
    ]);
    expect(h.engine.queue(id)).toMatchObject({ paused: false, resumeAt: null, pendingCount: 0 });
    h.clock.advance(5000);
    await h.engine.flush();
    expect(sends(replacement)).toHaveLength(3);
  },
);

test("a fresh message preserves a manual pause during a usage limit", async () => {
  const { h, id, replacement } = await limitedThread();
  expect(
    h.command({ type: "queue.pause", threadId: id, expectedRevision: h.engine.queue(id).revision })
      .ok,
  ).toBe(true);
  h.command({ type: "thread.send", threadId: id, input: text("keep queued") });
  await h.engine.flush();
  expect(sends(replacement)).toHaveLength(0);
  expect(h.engine.queue(id)).toMatchObject({ paused: true, reason: "manual" });
  expect(h.engine.queue(id).messages.map((message) => message.input)).toEqual([
    text("queued first"),
    text("queued second"),
    text("keep queued"),
  ]);
});

test("a provider refusal holds the queue again after an early retry", async () => {
  const { h, id, frames } = await limitedThread();
  const replacement = replaceProvider(h, frames, [
    { on: "send", frames: [frames.frame(start, quotaEnd, limited)] },
  ]);
  h.contexts[0]?.onExit({ deliberate: false, message: "quota exit" });
  await h.engine.flush();
  h.command({ type: "thread.send", threadId: id, input: text("try again") });
  await h.engine.flush();
  expect(sends(replacement)).toHaveLength(1);
  expect(h.store.getThread(id)?.status).toEqual({ state: "limited", until: 4000 });
  expect(h.engine.queue(id)).toMatchObject({ paused: true, reason: "limit" });
  expect(h.engine.queue(id).messages.map((message) => message.input)).toEqual([
    text("queued second"),
    text("try again"),
  ]);
});

test.each(["resume_now", "resume_at_reset", "snooze_until_reset"] as const)(
  "an unread usage-limit rejection returns to the strip and still supports %s",
  async (action) => {
    const { h, id, frames } = await limitedThread({
      preferences: { limitPolicy: action === "resume_now" ? "manual" : action },
    });
    const replacement = replaceProvider(
      h,
      frames,
      Array.from({ length: 4 }, () => ({
        on: "send" as const,
        frames: [frames.frame(start, end)],
      })),
    );
    const adapter = h.registry.get("codex").adapter;
    let refuse = true;
    h.registry.register(
      {
        ...adapter,
        async openSession(ctx) {
          const session = await adapter.openSession(ctx);
          const rejectedSession = refuse;
          return {
            ...session,
            close: rejectedSession ? async () => {} : session.close,
            async send(input, delivery, commandId) {
              if (refuse) {
                refuse = false;
                ctx.onFrame(frames.frame(limited));
                throw new InputRejected("Usage limit reached before input admission");
              }
              await session.send(input, delivery, commandId);
            },
          };
        },
      },
      { installed: true, auth: "logged_in", loginHint: "unused" },
    );
    h.contexts[0]?.onExit({ deliberate: false, message: "quota exit" });
    await h.engine.flush();
    h.command({ type: "thread.send", threadId: id, input: text("try again") });
    await h.engine.flush();
    expect(h.engine.queue(id)).toMatchObject({ paused: true, reason: "limit" });
    if (action !== "resume_now") expect(h.engine.queue(id).resumeAt).toBe(4000);
    expect(
      h.engine
        .queue(id)
        .messages.map((message) => ({ input: message.input, state: message.state })),
    ).toEqual([
      { input: text("queued first"), state: "queued" },
      { input: text("queued second"), state: "queued" },
      { input: text("try again"), state: "queued" },
    ]);
    expect(
      h.command({
        type: "thread.limit",
        threadId: id,
        expectedRevision: h.engine.queue(id).revision,
        action,
      }).ok,
    ).toBe(true);
    if (action !== "resume_now") {
      h.clock.advance(4000);
      await h.engine.flush();
      if (action === "snooze_until_reset") {
        expect(sends(replacement)).toHaveLength(0);
        expect(resume(h, h.engine, id).ok).toBe(true);
      }
    }
    await h.engine.flush();
    expect(
      sends(replacement)
        .slice(-3)
        .map((command) => command.input),
    ).toEqual([text("queued first"), text("queued second"), text("try again")]);
    expect(h.engine.queue(id)).toMatchObject({ paused: false, messages: [] });
  },
);
