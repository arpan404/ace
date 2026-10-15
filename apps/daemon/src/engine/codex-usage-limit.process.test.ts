import { afterEach, expect, test } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { createCodexAdapter } from "@ace/adapter-codex";
import { AccountRegistry, AccountService, createInstance } from "@ace/accounts";
import { ProviderPayload } from "@ace/provider-kit/payload";
import type { Frame, SessionContext } from "@ace/engine-api";
import type { ThreadId } from "@ace/protocol";
import { createScriptedAdapter, type ScriptedStep } from "@ace/adapter-testkit";
import { fixture, cleanupRecovery, text, sends } from "./recovery-test-support.ts";
import { scriptFrames } from "./test-support.ts";
import { recoveryPorts } from "../services/recovery.ts";
import { recoverOnFreshReadings } from "../services/limit-recovery.ts";
import type { RecoveryPorts } from "./recovery.ts";

/*
 * Usage limits through the real Codex translator and the real accounts service: app-server
 * frames go through the account registry exactly as in the daemon, and the thread's hold is
 * decided by what the provider definitely said.
 */

afterEach(cleanupRecovery);
const minute = 60_000;
let seq = 0;
const frame = (data: unknown): Frame => {
  const payload = new ProviderPayload(JSON.stringify(data));
  return { seq: ++seq, t: seq, dir: "recv", channel: "stdio", data: payload.data, payload };
};
const turn = (id: string, status: "completed" | "failed", error?: unknown): Frame[] => [
  frame({ method: "turn/started", params: { threadId: "native", turn: { id } } }),
  ...(error
    ? [frame({ method: "error", params: { threadId: "native", error, willRetry: false } })]
    : []),
  frame({
    method: "turn/completed",
    params: { threadId: "native", turn: { id, status, ...(error ? { error } : {}) } },
  }),
];
/** Codex's `RateLimitSnapshot` for its 5-hour window. */
const snapshot = (usedPercent: number, resetsAt: number) => ({
  method: "account/rateLimits/updated",
  params: {
    rateLimits: {
      limitId: "codex",
      limitName: null,
      primary: { usedPercent, windowDurationMins: 300, resetsAt: resetsAt / 1000 },
      secondary: null,
      planType: "plus",
      rateLimitReachedType: usedPercent >= 100 ? "rate_limit_reached" : null,
    },
  },
});
// Scripted steps clone frames, so re-admit their bytes at the provider boundary.
function encoded(context: SessionContext): SessionContext {
  return {
    ...context,
    onFrame(input) {
      const payload = new ProviderPayload(JSON.stringify(input.data));
      context.onFrame({ ...input, payload, data: payload.data });
    },
  };
}

/** A Codex thread on account "Sa"; each provider session after the first runs `later`. */
async function codexThread(
  steps: ScriptedStep[],
  later: ScriptedStep[] = [],
  policy: "manual" | "resume_at_reset" = "manual",
) {
  const ports: RecoveryPorts = {};
  const createTranslator = createCodexAdapter().createTranslator;
  const h = await fixture(steps, scriptFrames(), { recovery: ports, createTranslator });
  const first = h.registry.get("codex").adapter;
  const reopened = createScriptedAdapter({
    provider: "codex",
    capabilities: h.registry.get("codex").capabilities,
    nativeSessionId: "native-1",
    createTranslator,
    steps: later,
  });
  let opened = 0;
  const providerSends = () => sends(h.adapter).length + sends(reopened).length;
  const home = join(h.home, "account-a");
  await mkdir(home);
  const registry = new AccountRegistry(new DatabaseSync(join(h.home, "accounts.sqlite")));
  await registry.register(
    createInstance({ id: "account-a", provider: "codex", label: "Sa", homeDir: home }),
  );
  registry.ingest("account-a", {
    provider: "codex",
    payload: new ProviderPayload(JSON.stringify({ auth: "logged_in" })),
    observedAt: h.clock.now(),
    timeZone: "UTC",
  });
  const accounts = new AccountService({ registry, now: h.clock.now, timeZone: "UTC", env: {} });
  const native = {
    ...first,
    openSession: (context: SessionContext) =>
      (opened++ === 0 ? first : reopened).openSession(encoded(context)),
  };
  h.registry.register(
    accounts.bindAdapter({ ...first, create: () => native }, () => ({
      instanceId: "account-a",
      role: "worker",
      estimatedLoad: 1,
    })),
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  Object.assign(
    ports,
    recoveryPorts(
      { store: h.store, now: h.clock.now, services: { accounts, accountRegistry: registry } },
      (id) => h.engine.sessionMetadata(id),
    ),
    // The person's `threads.limitPolicy` setting.
    { preferences: async () => ({ followUpBehavior: "queue" as const, limitPolicy: policy }) },
  );
  const stop = recoverOnFreshReadings({
    subscribeQuota: (listener) => registry.subscribeQuota(listener),
    quota: (id) => registry.get(id)?.quota,
    recovered: (id) => h.engine.accountRecovered(id),
    now: h.clock.now,
  });
  return {
    h,
    registry,
    providerSends,
    async close() {
      stop();
      registry.close();
    },
  };
}
const started = frame({ method: "thread/started", params: { thread: { id: "native" } } });
const usageLimit = {
  message: "You've hit your usage limit. Try again later.",
  codexErrorInfo: "usageLimitExceeded",
};

test("a turn error without a definite limit signal does not hold queued messages", async () => {
  const { h, registry, close } = await codexThread([
    {
      on: "send",
      frames: [
        started,
        // A throttle Codex gave up retrying, in words that mention a rate limit.
        ...turn("A", "failed", {
          message: "Rate limit reached for gpt-6.1-sol on tokens per min. Please try again in 20s.",
          codexErrorInfo: "rateLimitExceeded",
        }),
      ],
    },
    { on: "send", frames: turn("B", "completed") },
  ]);
  try {
    const id = await h.create();
    expect(h.store.getThread(id)?.status.state).toBe("failed");
    expect(h.engine.queue(id)).toMatchObject({ paused: false });
    expect(registry.summary("account-a", h.clock.now())?.availability).toBe("available");
    h.command({ type: "thread.send", threadId: id, input: text("next") });
    await h.engine.flush();
    expect(sends(h.adapter)).toHaveLength(2);
    expect(h.engine.queue(id).messages).toEqual([]);
    expect(h.store.getThread(id)?.status.state).toBe("done");
  } finally {
    await close();
  }
});

const hitLimit = (reset: number): ScriptedStep[] => [
  {
    on: "send",
    frames: [started, frame(snapshot(100, reset)), ...turn("A", "failed", usageLimit)],
  },
  // Carrying on closes the limited session and opens a fresh one.
  { on: "close" },
];
const carriesOn: ScriptedStep[] = [
  { on: "send", frames: [started, ...turn("B", "completed")] },
  { on: "send", frames: turn("C", "completed") },
];
/** Once the limit has cleared, the open session carries on: nothing closes it. */
const clearedThen = (reset: number, turns: number): ScriptedStep[] => [
  {
    on: "send",
    frames: [started, frame(snapshot(100, reset)), ...turn("A", "failed", usageLimit)],
  },
  ...Array.from({ length: turns }, (_, index) => ({
    on: "send" as const,
    frames: turn(`after-${index}`, "completed"),
  })),
];
const resume = (h: Awaited<ReturnType<typeof codexThread>>["h"], id: ThreadId) =>
  h.command({ type: "thread.resume", threadId: id, expectedRevision: h.engine.queue(id).revision });

test("an explicit Codex rate-limit event with resetsAt holds the queue until the reset, then sends", async () => {
  const reset = 1_000 + 20 * minute;
  // The person chose to resume at the reset.
  const { h, providerSends, close } = await codexThread(
    hitLimit(reset),
    carriesOn,
    "resume_at_reset",
  );
  try {
    const id = await h.create();
    expect(h.store.getThread(id)?.status.state).toBe("limited");
    h.command({ type: "thread.send", threadId: id, input: text("after the reset") });
    await h.engine.flush();
    // Definite and timed: the person's message waits for the reset the provider gave.
    expect(h.engine.queue(id)).toMatchObject({ paused: true, reason: "limit", resumeAt: reset });
    h.clock.advance(reset - 1);
    await h.engine.flush();
    expect(providerSends()).toBe(1);
    h.clock.advance(reset);
    await h.engine.flush();
    // The continuation and then the held message reach Codex, in order.
    expect(providerSends()).toBe(3);
    expect(h.engine.queue(id)).toMatchObject({ paused: false, messages: [] });
    expect(h.store.getThread(id)?.status.state).toBe("done");
  } finally {
    await close();
  }
});

test("under the manual policy a reset clears the limit but sends nothing until the person resumes", async () => {
  const reset = 1_000 + 20 * minute;
  const { h, providerSends, close } = await codexThread(clearedThen(reset, 2));
  try {
    const id = await h.create();
    h.command({ type: "thread.send", threadId: id, input: text("held") });
    await h.engine.flush();
    // No resume is promised: ace never starts a turn by itself.
    expect(h.engine.queue(id)).toMatchObject({ paused: true, reason: "limit", resumeAt: null });
    h.clock.advance(reset);
    await h.engine.flush();
    expect(h.store.getThread(id)?.status.state).not.toBe("limited");
    expect(h.engine.queue(id)).toMatchObject({ paused: true, messages: [{ input: text("held") }] });
    expect(providerSends()).toBe(1);
    expect(resume(h, id).ok).toBe(true);
    await h.engine.flush();
    expect(providerSends()).toBe(3);
    expect(h.engine.queue(id)).toMatchObject({ paused: false, messages: [] });
  } finally {
    await close();
  }
});

test("after a cleared limit the person's next message is the go-ahead", async () => {
  const reset = 1_000 + 20 * minute;
  const { h, providerSends, close } = await codexThread(clearedThen(reset, 1));
  try {
    const id = await h.create();
    h.clock.advance(reset);
    await h.engine.flush();
    expect(providerSends()).toBe(1);
    h.command({ type: "thread.send", threadId: id, input: text("carry on") });
    await h.engine.flush();
    expect(providerSends()).toBe(2);
    expect(h.engine.queue(id)).toMatchObject({ paused: false, messages: [] });
    expect(h.store.getThread(id)?.status.state).toBe("done");
  } finally {
    await close();
  }
});

test("a fresh usage reading below the limit clears a limited account and its thread's limit", async () => {
  const reset = 1_000 + 25 * minute;
  const { h, registry, providerSends, close } = await codexThread(clearedThen(reset, 2));
  try {
    const id = await h.create();
    h.command({ type: "thread.send", threadId: id, input: text("queued") });
    await h.engine.flush();
    expect(registry.summary("account-a", h.clock.now())?.availability).toBe("exhausted");
    expect(h.engine.queue(id)).toMatchObject({ paused: true, reason: "limit" });
    // Codex re-read the account early (a banked reset was redeemed): it has room now.
    h.clock.advance(1_000 + 5 * minute);
    registry.ingest("account-a", {
      provider: "codex",
      payload: new ProviderPayload(
        JSON.stringify({
          rateLimitsByLimitId: {
            codex: {
              limitId: "codex",
              primary: { usedPercent: 3, windowDurationMins: 300, resetsAt: reset / 1000 },
            },
          },
        }),
      ),
      observedAt: h.clock.now(),
      timeZone: "UTC",
    });
    await h.engine.flush();
    expect(registry.summary("account-a", h.clock.now())?.availability).toBe("available");
    expect(h.store.getThread(id)?.status.state).not.toBe("limited");
    // The limit is gone, but ace starts no turn: the message waits for the person.
    expect(providerSends()).toBe(1);
    expect(h.engine.queue(id)).toMatchObject({
      paused: true,
      messages: [{ input: text("queued") }],
    });
    expect(resume(h, id).ok).toBe(true);
    await h.engine.flush();
    expect(providerSends()).toBe(3);
    expect(h.store.getThread(id)?.status.state).toBe("done");
  } finally {
    await close();
  }
});
