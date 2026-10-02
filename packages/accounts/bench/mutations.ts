/** Sequential mutation audit. Each production edit is restored even on test failure. */
import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const mutations = [
  {
    name: "write into overlapping source homes",
    file: "migration.ts",
    before: "if (contains(sourceHome, targetHome) || contains(targetHome, sourceHome))",
    after: "if (false)",
    test: "migration.test.ts",
  },
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
    file: "quota-decode.ts",
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
  {
    name: "ignore destination writer locks",
    file: "migration.ts",
    before: "await checkWriterLocks(targetHome, request.provider, plan.ids);",
    after: "// destination check removed",
    test: "review-migration.test.ts",
    all: true,
  },
  {
    name: "accept provider mismatch",
    file: "migration.ts",
    before: "from.provider !== request.provider ||\n        to.provider !== request.provider ||",
    after: "false ||",
    test: "review-migration.test.ts",
  },
  {
    name: "ignore changes during copying",
    file: "migration-files.ts",
    before: "if (fingerprint(before) !== fingerprint(after))",
    after: "if (false)",
    test: "review-migration.test.ts",
  },
  {
    name: "ignore source replacement after staging",
    file: "migration.ts",
    before: "!file || fingerprint(await lstat(file.source)) !== fingerprints[index]",
    after: "!file",
    test: "review-migration.test.ts",
  },
  {
    name: "remove native ID validation",
    file: "migration.ts",
    before: "NativeSessionId.parse(request.nativeSessionId)",
    after: "request.nativeSessionId",
    test: "review-migration.test.ts",
  },
  {
    name: "delete source on collision",
    file: "migration.ts",
    before: "if (source.hash !== destination.hash)\n            throw",
    after:
      "if (source.hash !== destination.hash) { await rm(file.source); }\n          if (source.hash !== destination.hash)\n            throw",
    test: "migration.test.ts",
  },
  {
    name: "accept unknown Claude statuses",
    file: "quota-decode.ts",
    before: 'z.enum(["allowed", "allowed_warning", "rejected"]).optional()',
    after: "z.string().optional()",
    test: "review-quota.test.ts",
  },
  {
    name: "clear exhaustion on incomplete snapshots",
    file: "quota.ts",
    before: "decoded.authoritative && decoded.complete && decoded.count",
    after: "decoded.authoritative && decoded.count",
    test: "review-quota.test.ts",
  },
  {
    name: "disable ingress decoding cap",
    file: "quota-decode.ts",
    before: "if (++inspected > 32)",
    after: "if (++inspected > 1000000)",
    test: "review-quota.test.ts",
  },
  {
    name: "skip canonicalization of home selectors",
    file: "paths.ts",
    before: "join(await realpath(ancestor), ...missing.toReversed())",
    after: "join(ancestor, ...missing.toReversed())",
    test: "review-quota.test.ts",
  },
  {
    name: "allow read-only migration after remote merge",
    file: "../../../apps/daemon/src/server.ts",
    before: 'const scope = message.type === "accounts.migrate" ? "operate" : "read";',
    after: 'const scope = "read";',
    test: "apps/daemon/src/accounts.server.test.ts",
  },
  {
    name: "probe unrelated providers for one account",
    file: "instances.ts",
    before: "const result = await discoverProvider(instance.provider, {",
    after:
      'const { discoverProviders } = await import("@ace/provider-kit/discovery"); await discoverProviders({ ...options, env: instanceEnv(instance, options.env ?? process.env) }); const result = await discoverProvider(instance.provider, {',
    test: "instances.test.ts",
  },
];
for (const mutation of mutations) {
  const path = new URL(`../src/${mutation.file}`, import.meta.url);
  const original = await readFile(path, "utf8");
  if (
    (!mutation.all && original.split(mutation.before).length !== 2) ||
    !original.includes(mutation.before)
  )
    throw new Error(`Nonunique mutation: ${mutation.name}`);
  try {
    await writeFile(
      path,
      mutation.all
        ? original.replaceAll(mutation.before, mutation.after)
        : original.replace(mutation.before, mutation.after),
    );
    let tail = "";
    const capture = (chunk: Buffer) => {
      tail = (tail + chunk.toString()).slice(-16_384);
    };
    const code = await new Promise<number | null>((resolve, reject) => {
      const child = spawn(
        "bun",
        [
          "run",
          "test",
          mutation.test.startsWith("apps/")
            ? mutation.test
            : `packages/accounts/src/${mutation.test}`,
        ],
        {
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
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
