/** Sequential mutation audit. Each production edit is restored even on test failure. */
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const mutations = [
  {
    name: "reuse global Cursor credentials",
    file: "instances.ts",
    before: 'env["AGENT_CLI_CREDENTIAL_STORE"] = "file";',
    after: 'env["AGENT_CLI_CREDENTIAL_STORE"] = undefined;',
    test: "instances.test.ts",
  },
  {
    name: "wrong Codex home",
    file: "instances.ts",
    before: "{ CODEX_HOME: homeDir }",
    after: '{ CODEX_HOME: join(homeDir, "wrong") }',
    test: "instances.test.ts",
  },
  {
    name: "ignore exhaustion",
    file: "quota.ts",
    before: "window.usedPercent >= 100",
    after: "window.usedPercent > 100",
    test: "quota.test.ts",
  },
  {
    name: "ignore near-limit threshold",
    file: "quota.ts",
    before: "window.usedPercent >= 80",
    after: "window.usedPercent >= 90",
    test: "quota.test.ts",
  },
  {
    name: "delay reset at exact boundary",
    file: "quota.ts",
    before: "window.resetsAt <= now",
    after: "window.resetsAt < now",
    test: "quota.test.ts",
  },
  {
    name: "allow stale quota rollback",
    file: "quota.ts",
    before: "fact.observedAt < state.observedAt",
    after: "fact.observedAt < 0",
    test: "quota.test.ts",
  },
  {
    name: "misread Claude utilization units",
    file: "quota.ts",
    before: "event.utilization * 100",
    after: "event.utilization",
    test: "quota.test.ts",
  },
  {
    name: "prefer later quota resets",
    file: "scheduler.ts",
    before: "nextReset < bestReset",
    after: "nextReset > bestReset",
    test: "quota.test.ts",
  },
  {
    name: "invert headroom eligibility",
    file: "scheduler.ts",
    before: "headroom < input.estimatedLoad",
    after: "headroom > input.estimatedLoad",
    test: "quota.test.ts",
  },
  {
    name: "omit fork ancestor history",
    file: "migration-plan.ts",
    before: "for (const parent of session.parents) visit(parent, depth + 1);",
    after: "for (const parent of []) visit(parent, depth + 1);",
    test: "migration.test.ts",
  },
  {
    name: "ignore native writer locks",
    file: "migration-plan.ts",
    before: "if (await exists(path))",
    after: "if (false)",
    test: "migration.test.ts",
  },
];
for (const mutation of mutations) {
  const path = new URL(`../src/${mutation.file}`, import.meta.url);
  const original = await readFile(path, "utf8");
  if (original.split(mutation.before).length !== 2)
    throw new Error(`Nonunique mutation: ${mutation.name}`);
  try {
    await writeFile(path, original.replace(mutation.before, mutation.after));
    let tail = "";
    const capture = (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-16_384);
    };
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn("bun", ["run", "test", `packages/accounts/src/${mutation.test}`], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      child.once("error", reject);
      child.once("exit", resolve);
    });
    if (code !== 1 || !tail.includes("AssertionError"))
      throw new Error(`Mutation did not fail a behavior assertion: ${mutation.name}\n${tail}`);
    process.stdout.write(`Killed: ${mutation.name}\n`);
  } finally {
    await writeFile(path, original);
  }
}
