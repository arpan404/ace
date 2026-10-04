import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

test("SQLite's known experimental warning is quiet while other experimental and coded warnings survive", async ({
  onTestFinished,
}) => {
  const home = await mkdtemp(join(tmpdir(), "ace-warnings-"));
  onTestFinished(() => rm(home, { recursive: true, force: true }));
  const { stderr } = await promisify(execFile)(process.execPath, [
    "--input-type=module",
    "-e",
    `
    import { Store } from ${JSON.stringify(new URL("./store.ts", import.meta.url).href)};
    const store = new Store(${JSON.stringify(join(home, "events.sqlite"))});
    // Node 24.13.0 emits this uncoded warning; later runtimes may no longer emit it.
    process.emitWarning("SQLite is an experimental feature and might change at any time", "ExperimentalWarning");
    process.emitWarning("another experimental feature", "ExperimentalWarning");
    process.emitWarning("SQLite is an experimental feature and might change at any time", { type: "ExperimentalWarning", code: "ACE_KEEP" });
    process.emitWarning("real deprecation", { type: "DeprecationWarning", code: "ACE_DEPRECATION" });
    store.close();
  `,
  ]);
  expect(stderr).not.toMatch(/\(node:\d+\) ExperimentalWarning: SQLite is an experimental feature/);
  expect(stderr).toContain("ExperimentalWarning: another experimental feature");
  expect(stderr).toContain("[ACE_KEEP]");
  expect(stderr).toContain("[ACE_DEPRECATION]");
});
