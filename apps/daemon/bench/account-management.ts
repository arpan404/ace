// Prepared for merge-time execution only. No provider CLI, SDK, login or credential files.
import { performance } from "node:perf_hooks";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "@ace/provider-kit/sqlite";
import { AccountRegistry, createInstance } from "@ace/accounts";
import { TerminalManager, type PtyBackend } from "@ace/terminal";

function measure(name: string, iterations: number, run: () => void) {
  for (let i = 0; i < 100; i++) run();
  const samples: number[] = [];
  const start = performance.now();
  for (let i = 0; i < iterations; i++) {
    const before = performance.now();
    run();
    samples.push(performance.now() - before);
  }
  const elapsed = performance.now() - start;
  samples.sort((a, b) => a - b);
  console.log(
    JSON.stringify({
      name,
      iterations,
      opsPerSecond: (iterations * 1000) / elapsed,
      p50Microseconds: (samples[Math.floor(samples.length * 0.5)] ?? 0) * 1000,
      p95Microseconds: (samples[Math.floor(samples.length * 0.95)] ?? 0) * 1000,
      peakRssMiB: process.resourceUsage().maxRSS / 1024,
    }),
  );
}
const noop = () => {};
const root = await realpath(await mkdtemp(join(tmpdir(), "ace-account-management-bench-")));
try {
  for (const count of [1, 64, 256]) {
    const registry = new AccountRegistry(new DatabaseSync(":memory:"));
    try {
      for (let i = 0; i < count; i++)
        await registry.register(
          createInstance({
            id: `account-${i}`,
            provider: "codex",
            label: `Account ${i}`,
            homeDir: join(root, `account-${i}`),
          }),
        );
      registry.selectProvider("codex", `account-${count - 1}`);
      let rows = 0;
      measure(`account list (${count})`, 1000, () => {
        rows = registry.summaries(100).length;
      });
      if (rows !== count) throw new Error("Benchmark account count changed");
    } finally {
      registry.close();
    }
  }
  let data: (bytes: Buffer) => void = noop;
  const backend: PtyBackend = {
    pid: 42,
    write() {},
    resize() {},
    kill: async () => {},
    close: async () => {},
    onData(listener) {
      data = listener;
      return () => {};
    },
    onExit() {
      return () => {};
    },
  };
  const manager = new TerminalManager({ dependencies: { backendFactory: () => backend } });
  let characters = 0;
  manager.openLiveTerminal(
    { cwd: root, cols: 80, rows: 24, name: "controlled benchmark" },
    (event) => {
      if (event.type === "data") characters += event.data.length;
    },
  );
  const bytes = Buffer.from(`${"a".repeat(16383)}😀`);
  try {
    measure("live UTF-8 forwarding (16387 bytes)", 10000, () => data(bytes));
  } finally {
    await manager.closeAll();
  }
  if (!characters) throw new Error("Benchmark emitted no output");
} finally {
  await rm(root, { recursive: true, force: true });
}
