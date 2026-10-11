import { expect, test } from "vitest";
import { ProviderLoginSessions } from "./index.ts";
import type { ProviderLoginProgress } from "@ace/protocol";

const start = { type: "provider.login.start", requestId: "start", provider: "codex" } as const;

test.each([true, false])(
  "login success respects admission freshness %s after final cleanup",
  async (unchanged) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    let verified = false;
    let fresh = true;
    const sessions = new ProviderLoginSessions({
      now: () => 100,
      id: () => "completion",
      schedule: () => () => {},
      prepare: async () => ({
        run: async () => ({ success: true }),
        changed: async () => {
          verified = true;
        },
        async drain() {
          if (verified) {
            entered.resolve();
            await release.promise;
          }
        },
        isCurrent: () => fresh,
      }),
    });
    try {
      await sessions.handle("owner", start);
      await entered.promise;
      fresh = unchanged;
      release.resolve();
      expect((await sessions.completed("owner", "completion")).state).toBe(
        unchanged ? "succeeded" : "failed",
      );
      expect(sessions.busy("codex")).toBe(false);
    } finally {
      release.resolve();
      await sessions.close();
    }
  },
);

test("a CLI whose cleanup failed cannot be reported successful or replaced until cancellation drains it", async () => {
  let canDrain = false;
  let sequence = 0;
  const events: ProviderLoginProgress[] = [];
  const cleanupFailed = Promise.withResolvers<void>();
  const scheduled: (() => void)[] = [];
  const sessions = new ProviderLoginSessions({
    now: () => 1000,
    id: () => `login-${++sequence}`,
    schedule(callback) {
      scheduled.push(callback);
      return () => {};
    },
    prepare: async () => ({
      run: async () => ({ success: true }),
      drain: async () => {
        if (!canDrain) throw new Error("Unverified process exit");
      },
    }),
  });
  sessions.listen((_owner, progress) => {
    events.push(progress);
    if (progress.message?.includes("cleanup")) cleanupFailed.resolve();
  });
  try {
    await sessions.handle("phone", start);
    await cleanupFailed.promise;
    expect(events.some((progress) => progress.state === "succeeded")).toBe(false);
    expect(await sessions.handle("phone", { ...start, requestId: "replacement" })).toMatchObject({
      result: { error: "busy" },
    });
    expect(
      await sessions.handle("phone", {
        type: "provider.login.cancel",
        requestId: "cancel",
        session: "login-1",
      }),
    ).toMatchObject({ result: { error: "busy" } });
    scheduled[0]?.();
    canDrain = true;
    expect(
      await sessions.handle("phone", {
        type: "provider.login.cancel",
        requestId: "retry",
        session: "login-1",
      }),
    ).toMatchObject({ result: { progress: { state: "cancelled" } } });
    scheduled.at(-1)?.();
    expect(
      await sessions.handle("phone", {
        type: "provider.login.poll",
        requestId: "expired",
        session: "login-1",
      }),
    ).toMatchObject({ result: { error: "not_found" } });
    expect(await sessions.handle("phone", { ...start, requestId: "replacement" })).toMatchObject({
      result: { progress: { state: "starting", session: "login-2" } },
    });
  } finally {
    canDrain = true;
    await sessions.close();
  }
});

test("provider-instance aliases share one reservation and cancellation waits for preparation", async () => {
  const admitted = Promise.withResolvers<void>();
  const prepared = Promise.withResolvers<void>();
  let sequence = 0;
  const sessions = new ProviderLoginSessions({
    now: () => 1000,
    id: () => `login-${++sequence}`,
    schedule: () => () => {},
    instanceKey: (_provider, instance) => instance ?? "selected-sdk",
    prepare: async () => {
      admitted.resolve();
      await prepared.promise;
      return { run: async () => ({ success: true }) };
    },
  });
  try {
    await sessions.handle("phone", { ...start, provider: "cursor" });
    await admitted.promise;
    expect(
      await sessions.handle("phone", {
        ...start,
        requestId: "another",
        provider: "cursor",
        instance: "selected-sdk",
      }),
    ).toMatchObject({ result: { error: "busy" } });
    const cancel = sessions.handle("phone", {
      type: "provider.login.cancel",
      requestId: "cancel",
      session: "login-1",
    });
    expect(
      await sessions.handle("phone", {
        type: "provider.login.poll",
        requestId: "poll",
        session: "login-1",
      }),
    ).toMatchObject({ result: { progress: { state: "starting" } } });
    prepared.resolve();
    expect(await cancel).toMatchObject({ result: { progress: { state: "cancelled" } } });
  } finally {
    prepared.resolve();
    await sessions.close();
  }
});
