/** Merge-time benchmark only. Never imported by tests or executed during review. */
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { assertTestHomeIsolation } from "@ace/provider-kit/test-isolation";

const iterations = z.coerce
  .number()
  .int()
  .min(100)
  .max(1_000_000)
  .parse(process.env.ACE_TEST_GUARD_BENCH_ITERATIONS ?? 10_000);
const root = await mkdtemp(
  join(process.platform === "darwin" ? "/tmp" : tmpdir(), "ace-guard-bench-"),
);
const originalGuard = process.env.ACE_TEST_REAL_HOME;
delete process.env.ACE_TEST_REAL_HOME;
try {
  const protectedHome = join(root, "owner"),
    safeHome = join(root, "safe"),
    alias = join(root, "alias");
  await mkdir(protectedHome);
  await mkdir(safeHome);
  await symlink(protectedHome, alias, "junction");
  const missing = join(safeHome, ...Array.from({ length: 16 }, () => "missing"));
  const aliasedDestination = join(alias, "missing/data");
  const scenarios = [
    { name: "baseline", run() {} },
    { name: "inactive", run: () => assertTestHomeIsolation(safeHome) },
    { name: "active-existing", run: () => assertTestHomeIsolation(safeHome, protectedHome) },
    {
      name: "active-missing-16",
      run: () => assertTestHomeIsolation(missing, protectedHome),
    },
    {
      name: "active-alias-rejection",
      run() {
        try {
          assertTestHomeIsolation(aliasedDestination, protectedHome);
        } catch (error) {
          if (error instanceof Error && error.message.includes("ACE_TEST_REAL_HOME guard")) return;
          throw error;
        }
        throw new Error("Protected alias was admitted");
      },
    },
  ];
  const results: {
    scenario: string;
    iterations: number;
    elapsedMs: number;
    nsPerOperation: number;
  }[] = [];
  for (const scenario of scenarios) {
    for (let index = 0; index < 100; index++) scenario.run();
    const start = process.hrtime.bigint();
    for (let index = 0; index < iterations; index++) scenario.run();
    const elapsed = Number(process.hrtime.bigint() - start);
    results.push({
      scenario: scenario.name,
      iterations,
      elapsedMs: elapsed / 1_000_000,
      nsPerOperation: elapsed / iterations,
    });
  }
  process.stdout.write(
    `${JSON.stringify({ node: process.version, platform: process.platform, results }, null, 2)}\n`,
  );
} finally {
  if (originalGuard === undefined) delete process.env.ACE_TEST_REAL_HOME;
  else process.env.ACE_TEST_REAL_HOME = originalGuard;
  await rm(root, { recursive: true, force: true });
}
