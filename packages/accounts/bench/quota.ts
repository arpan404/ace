import { performance } from "node:perf_hooks";
import { createInstance, initialQuota, ingestQuota, pickInstance } from "../src/index.ts";
import type { AccountQuota } from "@ace/protocol/accounts";
const candidates = Array.from({ length: 256 }, (_, index) => ({
  instance: createInstance({
    id: `account-${index}`,
    provider: "codex",
    label: `Account ${index}`,
    homeDir: `/tmp/ace-bench-${index}`,
  }),
  quota: {
    ...initialQuota(),
    auth: "logged_in" as const,
    windows: { primary: { usedPercent: index % 79, resetsAt: 1_800_000_000_000 + index } },
  },
}));
let state: AccountQuota = { ...initialQuota(), auth: "logged_in" };
const payload = {
  method: "account/rateLimits/updated",
  params: {
    rateLimits: { limitId: "codex", primary: { usedPercent: 30, resetsAt: 1_800_000_000 } },
  },
};
function measure(name: string, count: number, fn: (index: number) => void) {
  for (let index = 0; index < 10000; index++) fn(index);
  const start = performance.now();
  for (let index = 0; index < count; index++) fn(index);
  const elapsed = performance.now() - start;
  process.stdout.write(
    `${name}: ${Math.round((count / elapsed) * 1000)} ops/s, ${((elapsed * 1000) / count).toFixed(2)} us/op, peak RSS ${(process.resourceUsage().maxRSS / 1024).toFixed(1)} MiB\n`,
  );
}
let observedAt = 1_000_000;
measure("quota fold", 200000, () => {
  state = ingestQuota(state, {
    provider: "codex",
    payload,
    observedAt: observedAt++,
    timeZone: "UTC",
  }).state;
});
measure("pick among 256", 10000, () => {
  pickInstance(
    { provider: "codex", role: "worker", estimatedLoad: 10 },
    candidates,
    1_790_000_000_000,
  );
});
const large = Object.fromEntries(
  Array.from({ length: 100000 }, (_, i) => [`window-${i}`, { utilization: 10 }]),
);
const rssBefore = process.memoryUsage().rss;
const largeStart = performance.now();
const bounded = ingestQuota(state, {
  provider: "claude",
  payload: { rate_limits: large },
  observedAt: observedAt++,
  timeZone: "UTC",
});
process.stdout.write(
  `100,000-window ingress: ${(performance.now() - largeStart).toFixed(2)} ms, RSS delta ${((process.memoryUsage().rss - rssBefore) / 1048576).toFixed(1)} MiB, retained ${Object.keys(bounded.state.windows).length} windows, overflow ${bounded.state.blockers.overflow === true}\n`,
);
// Measure the adapter-facing hot path independently from quota snapshots.
const { mkdtemp, rm } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { join } = await import("node:path");
const { AccountService, openRegistry } = await import("../src/index.ts");
const root = await mkdtemp(join(tmpdir(), "ace-accounts-bench-"));
const registry = await openRegistry(join(root, "accounts.sqlite"));
await registry.register(
  createInstance({ id: "bench", provider: "codex", label: "bench", homeDir: join(root, "home") }),
);
const service = new AccountService({ registry, now: () => observedAt++, timeZone: "UTC", env: {} });
let dispatch: import("@ace/engine-api").SessionContext["onFrame"] | undefined;
const adapter: import("@ace/engine-api").ProviderAdapter = {
  provider: "codex",
  capabilities: () => {
    throw new Error("Unused");
  },
  createTranslator: () => {
    throw new Error("Unused");
  },
  openSession: async (context) => {
    dispatch = context.onFrame;
    return {
      nativeSessionId: "bench",
      send: async () => {},
      interrupt: async () => {},
      resolve: async () => {},
      stopTask: async () => {},
      close: async () => {},
    };
  },
};
try {
  const { ThreadId } = await import("@ace/protocol");
  const opened = await service.openSession(
    adapter,
    {
      threadId: ThreadId.parse("bench"),
      cwd: root,
      signal: new AbortController().signal,
      onFrame: () => {},
      onExit: () => {},
    },
    { instanceId: "bench", role: "worker", estimatedLoad: 1 },
  );
  const emit = dispatch;
  if (!emit) throw new Error("Missing adapter sink");
  const frame = {
    seq: 1,
    t: 0,
    dir: "recv" as const,
    channel: "stdio",
    data: { method: "item/agentMessage/delta", params: { delta: "small change" } },
  };
  measure("adapter delta forwarding", 1000000, () => emit(frame));
  measure("persisted quota update", 10000, () =>
    registry.ingest("bench", {
      provider: "codex",
      payload,
      observedAt: observedAt++,
      timeZone: "UTC",
    }),
  );
  await opened.session.close("shutdown");
} finally {
  registry.close();
  await rm(root, { recursive: true, force: true });
}
