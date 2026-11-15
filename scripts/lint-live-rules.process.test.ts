import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

/*
 * The `ace/live-words` and `ace/live-actions` rules, run by oxlint itself: the plugin only runs
 * in oxlint's JS plugin host, on the AST oxlint builds, so one real run over a table of files is
 * the test. Each file says what it does with a gated name; the rules must report exactly the
 * bypasses.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const plugin = join(root, "tools/lint/ace-live-actions.mjs");
const oxlint = join(root, "node_modules/.bin/oxlint");

/** Fixture file → what it holds. */
const files: Record<string, string> = {
  // live-words: the three bypasses.
  "src/words-barrel.ts": 'export { agentStep as stepWords } from "@ace/ui-core";\n',
  "src/words-star.ts": 'export * from "@ace/ui-core";\n',
  "src/words-star-as.ts": 'export * as ui from "@ace/ui-core";\n',
  "src/words-computed.ts":
    'import * as ui from "@ace/ui-core";\nexport const a = ui["agentStep"];\nexport const b = ui[`subagentLabels`];\n',
  "src/words-destructured.ts":
    'import * as ui from "@ace/ui-core";\nconst { agentStep } = ui;\nexport const step = agentStep;\n',
  // Allowed: a live-words.ts file may use a formatter, but never pass one on.
  "src/feature/live-words.ts":
    'import { agentStep } from "@ace/ui-core";\nexport const words = (live: boolean) => (live ? agentStep : undefined);\n',
  "src/other/live-words.ts": 'export { agentStep } from "@ace/ui-core";\n',
  // live-actions: the same bypasses for a sending helper.
  "src/actions-barrel.ts": 'export { retrySend as again } from "@ace/client";\n',
  "src/actions-star.ts": 'export * from "@ace/client";\n',
  "src/actions-computed.ts":
    'import * as client from "@ace/client";\nexport const retry = client["retrySend"];\n',
  // Nothing gated: no report.
  "src/clean.ts":
    'import { agentName } from "@ace/ui-core";\nexport { agentName };\nexport * from "./local.ts";\nexport * from "@ace/ui-core/workspace-tabs";\nexport const ok = { a: 1 }["a"];\n',
};

let dir = "";
let reported: Record<string, string[]> = {};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "ace-lint-rules-"));
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  writeFileSync(join(dir, "src/local.ts"), "export const local = 1;\n");
  writeFileSync(
    join(dir, ".oxlintrc.json"),
    JSON.stringify({
      categories: { correctness: "off" },
      jsPlugins: [plugin],
      rules: { "ace/live-words": "error", "ace/live-actions": "error" },
    }),
  );
  const run = spawnSync(oxlint, ["-c", ".oxlintrc.json", "-f", "json", "src"], {
    cwd: dir,
    encoding: "utf8",
  });
  const output: { diagnostics: { code: string; filename: string; message: string }[] } = JSON.parse(
    run.stdout,
  );
  reported = {};
  for (const diagnostic of output.diagnostics)
    (reported[diagnostic.filename] ??= []).push(diagnostic.code);
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test("a formatter re-exported under another name, or with its whole package, is reported", () => {
  expect(reported["src/words-barrel.ts"]).toEqual(["ace(live-words)"]);
  // ui-core also holds a sending helper: its whole package is both rules' concern.
  expect(reported["src/words-star.ts"]?.toSorted()).toEqual([
    "ace(live-actions)",
    "ace(live-words)",
  ]);
  expect(reported["src/words-star-as.ts"]?.toSorted()).toEqual([
    "ace(live-actions)",
    "ace(live-words)",
  ]);
});

test("a formatter reached by a computed property or a destructured binding is reported", () => {
  expect(reported["src/words-computed.ts"]).toEqual(["ace(live-words)", "ace(live-words)"]);
  expect(reported["src/words-destructured.ts"]).toEqual(["ace(live-words)"]);
});

test("a live-words.ts file may use a formatter but not re-export it", () => {
  expect(reported["src/feature/live-words.ts"]).toBeUndefined();
  expect(reported["src/other/live-words.ts"]).toEqual(["ace(live-words)"]);
});

test("a sending helper re-exported, with its package, or by a computed property is reported", () => {
  expect(reported["src/actions-barrel.ts"]).toEqual(["ace(live-actions)"]);
  expect(reported["src/actions-star.ts"]).toEqual(["ace(live-actions)"]);
  expect(reported["src/actions-computed.ts"]).toEqual(["ace(live-actions)"]);
});

test("names nobody gates, re-exports of modules without them and other computed access report nothing", () => {
  expect(reported["src/clean.ts"]).toBeUndefined();
});
