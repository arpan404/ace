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
measure("quota fold", 200000, (index) => {
  state = ingestQuota(state, {
    provider: "codex",
    payload,
    observedAt: index + 1_000_000,
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
