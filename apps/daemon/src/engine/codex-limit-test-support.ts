import { DatabaseSync } from "node:sqlite";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCodexAdapter } from "@ace/adapter-codex";
import { AccountRegistry, AccountService, createInstance } from "@ace/accounts";
import { ProviderPayload } from "@ace/provider-kit/payload";
import type { Frame, SessionContext } from "@ace/engine-api";
import { createScriptedAdapter, type ScriptedStep } from "@ace/adapter-testkit";
import type { Engine } from "@ace/daemon";
import { fixture, restart, sends } from "./recovery-test-support.ts";
import { scriptFrames } from "./test-support.ts";
import { recoveryPorts } from "../services/recovery.ts";
import { recoverOnFreshReadings } from "../services/limit-recovery.ts";
import { AccountManagement, freshLimitsWaitMs } from "../account-management.ts";
import type { ReadCliUsage } from "../account-limits.ts";
import type { RecoveryPorts } from "./recovery.ts";

/*
 * A Codex thread through the real Codex translator, the real account registry and the engine,
 * for usage-limit tests: app-server frames go through the registry exactly as in the daemon.
 */

export const minute = 60_000;
let seq = 0;
export const frame = (data: unknown): Frame => {
  const payload = new ProviderPayload(JSON.stringify(data));
  return { seq: ++seq, t: seq, dir: "recv", channel: "stdio", data: payload.data, payload };
};
export const turn = (id: string, status: "completed" | "failed", error?: unknown): Frame[] => [
  frame({ method: "turn/started", params: { threadId: "native", turn: { id } } }),
  ...(error
    ? [frame({ method: "error", params: { threadId: "native", error, willRetry: false } })]
    : []),
  frame({
    method: "turn/completed",
    params: { threadId: "native", turn: { id, status, ...(error ? { error } : {}) } },
  }),
];
/** Codex's `RateLimitSnapshot` for its 5-hour window; a null reset is one Codex didn't give. */
export const snapshot = (usedPercent: number, resetsAt: number | null) => ({
  method: "account/rateLimits/updated",
  params: {
    rateLimits: {
      limitId: "codex",
      limitName: null,
      primary: {
        usedPercent,
        windowDurationMins: 300,
        resetsAt: resetsAt === null ? null : resetsAt / 1000,
      },
      secondary: null,
      planType: "plus",
      rateLimitReachedType: usedPercent >= 100 ? "rate_limit_reached" : null,
    },
  },
});
/** What `account/rateLimits/read` answers for the same window. */
export const reading = (usedPercent: number, resetsAt: number | null) => ({
  rateLimitsByLimitId: {
    codex: {
      limitId: "codex",
      primary: {
        usedPercent,
        windowDurationMins: 300,
        resetsAt: resetsAt === null ? null : resetsAt / 1000,
      },
    },
  },
});
export const started = frame({ method: "thread/started", params: { thread: { id: "native" } } });
export const usageLimit = {
  message: "You've hit your usage limit. Try again later.",
  codexErrorInfo: "usageLimitExceeded",
};
/** Once the limit has cleared, the open session carries on: nothing closes it. */
export const clearedThen = (reset: number | null, turns: number): ScriptedStep[] => [
  {
    on: "send",
    frames: [started, frame(snapshot(100, reset)), ...turn("A", "failed", usageLimit)],
  },
  ...Array.from({ length: turns }, (_, index) => ({
    on: "send" as const,
    frames: turn(`after-${index}`, "completed"),
  })),
];

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

/**
 * A Codex thread on account "Sa" (`account-a`), with `others` as further signed-in accounts;
 * each provider session after the first runs `later`. `unpinned`: no account is named, so the
 * session picks one by quota, as a thread with no account chosen does.
 */
export async function codexThread(
  steps: ScriptedStep[],
  later: ScriptedStep[] = [],
  policy: "manual" | "resume_at_reset" = "manual",
  others: string[] = [],
  unpinned = false,
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
  const contexts: SessionContext[] = [];
  const providerSends = () => sends(h.adapter).length + sends(reopened).length;
  const registry = new AccountRegistry(new DatabaseSync(join(h.home, "accounts.sqlite")));
  for (const [id, label] of [
    ["account-a", "Sa"],
    ...others.map((other) => [other, other]),
  ] as const) {
    const home = join(h.home, id);
    await mkdir(home);
    await registry.register(createInstance({ id, provider: "codex", label, homeDir: home }));
    registry.ingest(id, {
      provider: "codex",
      payload: new ProviderPayload(JSON.stringify({ auth: "logged_in" })),
      observedAt: h.clock.now(),
      timeZone: "UTC",
    });
  }
  let management: AccountManagement | undefined;
  const accounts = new AccountService({
    registry,
    now: h.clock.now,
    timeZone: "UTC",
    env: {},
    freshen: (signal) => management?.limits.fresh(freshLimitsWaitMs, signal) ?? Promise.resolve(),
  });
  const native = {
    ...first,
    openSession: (context: SessionContext) => {
      contexts.push(context);
      return (opened++ === 0 ? first : reopened).openSession(encoded(context));
    },
  };
  h.registry.register(
    accounts.bindAdapter({ ...first, create: () => native }, () => ({
      ...(unpinned ? {} : { instanceId: "account-a" }),
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
  // The engine fresh readings are told to; a restart replaces it.
  let engine: Engine = h.engine;
  const stop = recoverOnFreshReadings({
    subscribeQuota: (listener) => registry.subscribeQuota(listener),
    quota: (id) => registry.get(id)?.quota,
    recovered: (id) => engine.accountRecovered(id),
    now: h.clock.now,
  });
  return {
    h,
    registry,
    providerSends,
    engine: () => engine,
    /** The provider process of the latest session exits, as a CLI does after its turn. */
    exitSession() {
      contexts.at(-1)?.onExit({ deliberate: false, message: "codex exited" });
    },
    /** The daemon restarts on the same store while the thread is held. */
    async restart() {
      engine = await restart(h, { registry: h.registry, recovery: ports });
      return engine;
    },
    /**
     * Account management as the daemon runs it, its limit reads answered by `read` (the stand-in
     * for each account's `codex app-server`, which never runs), told by the engine whether limits
     * matter now.
     */
    async management(read: ReadCliUsage) {
      const executable = join(h.home, "codex");
      // Found on disk as the account's CLI; the read stand-in answers instead of running it.
      await writeFile(executable, "#!/bin/sh\nexit 1\n");
      await chmod(executable, 0o755);
      management = new AccountManagement({
        registry,
        accounts,
        env: {},
        dataDir: h.home,
        now: h.clock.now,
        id: () => `id-${++seq}`,
        models: () => undefined,
        discovery: { overrides: { codex: executable } },
        readCodexUsage: read,
        limitsBusy: () => engine.limitsMatter(),
        after: (ms, run) => h.clock.setTimer(run, ms),
      });
      return management;
    },
    async close() {
      stop();
      await management?.close();
      registry.close();
    },
  };
}
