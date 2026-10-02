import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { z } from "zod";

// Merge-time verification only; do not run during feature or review work. Every mutation is restored even if Vitest or reporting fails.
const cases = [
  {
    file: "scan.ts",
    before: "if (catalog.touch(instance.id, path, fp, epoch))",
    after: "if (false && catalog.touch(instance.id, path, fp, epoch))",
    test: "warm scans read zero content",
    change: "Reread unchanged files",
  },
  {
    file: "map-history.ts",
    before: "const chunk = text.slice(offset, offset + 4096);",
    after: 'const chunk = "";',
    test: "workspace lists retain native metadata",
    change: "Discard imported message text",
  },
  {
    file: "import-history.ts",
    before: "const native = { provider: root.summary.provider, nativeId: root.summary.nativeId };",
    after: 'const native = { provider: root.summary.provider, nativeId: "wrong-native-id" };',
    test: "workspace lists retain native metadata",
    change: "Lose resumable native identity",
  },
  {
    file: "import-history.ts",
    before: "catalog.children(instance.id, source.summary.nativeId)",
    after: "catalog.children(instance.id, source.summary.nativeId).slice(0, 0)",
    test: "Claude sidechains become child agents",
    change: "Omit subagent history",
  },
  {
    file: "map-history.ts",
    before: "return [ctx.raw];",
    after: "return [];",
    test: "unknown native records survive",
    change: "Drop unknown raw records",
  },
  {
    file: "index.ts",
    before: "signal?.throwIfAborted();",
    after: "void signal;",
    all: true,
    test: "cancellation rolls back while a slow sink",
    change: "Ignore cancellation at pull boundaries",
  },
  {
    file: "archive.ts",
    before: "UPDATE imported_threads SET published=1 WHERE id=?",
    after: "UPDATE imported_threads SET published=0 WHERE id=?",
    test: "workspace lists retain native metadata",
    change: "Never publish a committed thread",
  },
  {
    file: "archive.ts",
    before: "return { bytes, size };",
    after: "return { bytes: Buffer.alloc(bytes.length), size };",
    test: "oversized records stream losslessly",
    change: "Return corrupt zero-filled blob bytes",
  },
  {
    file: "import-history.ts",
    before: 'throw new Error("History source changed during import");',
    after: "void 0;",
    test: "source changes during import roll back",
    change: "Publish history after a source change",
  },
  {
    file: "provider-db.ts",
    before: 'countAccuracy: "sampled",',
    after: 'countAccuracy: "exact",',
    testFile: "review.test.ts",
    test: "database metadata remains listed",
    change: "Invent an exact database-only count",
  },
  {
    file: "archive-contracts.ts",
    before: ".max(200)",
    after: ".max(2000)",
    testFile: "observed-reads.test.ts",
    test: "item pages refuse limits above 200",
    change: "Increase the page cap to 2000",
  },
  {
    file: "scan.ts",
    before: "if (fp !== (await databaseFingerprint(path)))",
    after: "if (false && fp !== (await databaseFingerprint(path)))",
    testFile: "observed-reads.test.ts",
    test: "a database changed while scanning",
    change: "Remove final scan stability verification",
  },
  {
    file: "map-history.ts",
    before: "const output = string(p.output);",
    after: "const output = undefined;",
    testFile: "review.test.ts",
    test: "codex native results complete",
    change: "Drop Codex result text",
  },
  {
    file: "scan.ts",
    before: "result.skipped++;",
    after: "await readHeadTail(instance.homeDir, path, signal); result.skipped++;",
    testFile: "observed-reads.test.ts",
    test: "warm cached scans perform no actual",
    change: "Reread cached files without reporting reads",
  },
];
const reportSchema = z.object({
  numFailedTests: z.number().positive(),
  numTotalTests: z.number().positive(),
  testResults: z.array(
    z.object({
      assertionResults: z.array(
        z.object({
          title: z.string(),
          status: z.string(),
          failureMessages: z.array(z.string()).default([]),
        }),
      ),
    }),
  ),
});
const packageRoot = new URL("..", import.meta.url).pathname;
const temp = await mkdtemp(join(packageRoot, ".mutations-"));
const results: string[] = [];
try {
  for (const mutation of cases) {
    const path = join(packageRoot, "src", mutation.file);
    const original = await readFile(path, "utf8");
    if (!original.includes(mutation.before))
      throw new Error(`Missing mutation anchor: ${mutation.change}`);
    try {
      await writeFile(
        path,
        mutation.all
          ? original.replaceAll(mutation.before, mutation.after)
          : original.replace(mutation.before, mutation.after),
      );
      const report = join(temp, "report.json");
      const run = spawnSync(
        "bun",
        [
          "run",
          "test",
          "--",
          `packages/history-import/src/${mutation.testFile ?? "history.test.ts"}`,
          "-t",
          mutation.test,
          "--testTimeout=30000",
          "--reporter=json",
          `--outputFile=${report}`,
        ],
        { cwd: new URL("../../../", import.meta.url), encoding: "utf8", timeout: 60000 },
      );
      if (run.status === 0) throw new Error(`Surviving mutation: ${mutation.change}`);
      const parsed = reportSchema.parse(JSON.parse(await readFile(report, "utf8")));
      const failed = parsed.testResults
        .flatMap((r) => r.assertionResults)
        .find((r) => r.status === "failed" && r.title.includes(mutation.test));
      if (
        failed?.failureMessages.some((message) =>
          /timed out|Timeout|SyntaxError|Cannot find module/i.test(message),
        )
      )
        throw new Error(`Invalid mutation failure: ${mutation.change}`);
      if (!failed) throw new Error(`Mutation did not fail its named behavior: ${mutation.change}`);
      console.log(`Killed: ${mutation.change}`);
      results.push(`| ${mutation.change} | ${failed.title} | Failed |`);
    } finally {
      await writeFile(path, original);
    }
  }
  await writeFile(
    join(packageRoot, "MUTATIONS.md"),
    "# Mutation verification\n\nRun `node packages/history-import/bench/mutations.ts` from the repo root. Merge-time execution: fourteen deliberate production changes, including all five review survivors, each failed the named public behavior test. All source bytes were restored after each run. Syntax/import failures do not count; the reporter must contain a failed assertion for the selected behavior.\n\n| Production mutation | Behavior test | Result |\n| --- | --- | --- |\n" +
      results.join("\n") +
      "\n",
  );
} finally {
  await rm(temp, { recursive: true, force: true });
}
