import { facts, type FakeDaemon } from "@ace/fake-daemon";

/*
 * The spike's `ios-tree` thread for the Agents and Changes sheets: a finished root whose
 * subagents still work (one nested, one in the background), a running background command,
 * reported usage, and an uncommitted checkout with a small diff, a 3,000-line file and a
 * long line. No provider CLI runs.
 */

const longLine = `export const banner = "${"kill-all only stops processes this daemon started. ".repeat(40)}";`;
const big = Array.from({ length: 3000 }, (_, index) => `+  "fixture-${index + 1}",`).join("\n");
const patch = [
  "diff --git a/packages/provider-kit/src/process-owner.ts b/packages/provider-kit/src/process-owner.ts",
  "index 3b18e51..9a4c2f0 100644",
  "--- a/packages/provider-kit/src/process-owner.ts",
  "+++ b/packages/provider-kit/src/process-owner.ts",
  "@@ -41,6 +41,9 @@ export async function stopOwned(record: OwnedProcess, clock: Clock) {",
  "   const pid = record.pid;",
  '-  if (alive(pid)) kill(pid, "SIGTERM");',
  "+  const id = await identity(pid);",
  '+  if (!id || !sameOwner(id, record)) return "skip";',
  '+  if (id.startedAt !== record.startedAt) return "skip";',
  "+  await terminate(record.group, clock);",
  '   return "stopped";',
  " }",
  " ",
  "diff --git a/apps/daemon/src/cli/kill-all.ts b/apps/daemon/src/cli/kill-all.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/apps/daemon/src/cli/kill-all.ts",
  "@@ -0,0 +1,2 @@",
  `+${longLine}`,
  "+export { killAll } from './kill-all-core.ts';",
  "diff --git a/apps/daemon/src/cli/kill-all.fixtures.ts b/apps/daemon/src/cli/kill-all.fixtures.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/apps/daemon/src/cli/kill-all.fixtures.ts",
  "@@ -0,0 +1,3000 @@",
  big,
  "",
].join("\n");

export function seedSheets(daemon: FakeDaemon): void {
  daemon.apply("ios-tree", [
    facts.subagent("codex", "explorer", "Explorer", "spawn-explorer"),
    facts.turn("explorer", "spawn"),
    facts.endTurn("explorer"),
    facts.subagent("codex", "writer", "Test writer", "spawn-writer", { background: true }),
    facts.turn("writer", "spawn"),
    facts.subagent("codex", "fixtures", "Fixture builder", "spawn-fixtures", { parent: "writer" }),
    facts.turn("fixtures", "spawn"),
    {
      type: "background.started",
      agent: "writer",
      task: "watch",
      kind: "shell",
      title: "bun run test --watch",
      stoppable: true,
    },
    { type: "usage", agent: "root", inputTokens: 41_000, outputTokens: 2_400 },
    { type: "usage", agent: "explorer", inputTokens: 17_200, outputTokens: 800 },
    { type: "usage", agent: "writer", inputTokens: 29_500, outputTokens: 1_500 },
    { type: "context.sample", agent: "root", usedTokens: 92_000, windowTokens: 200_000 },
  ]);
  daemon.workspace.setDetails("ios-tree", {
    worktree: "/tmp/ace-ios-spike/worktrees/ios-tree",
    head: "3".repeat(40),
    ahead: 0,
    behind: 0,
    diff: { files: 3, additions: 3006, deletions: 1 },
    repository: { forge: "github", host: "github.com", owner: "arpan404", name: "ace" },
  });
  daemon.workspace.setGitStatus("ios-tree", [
    {
      path: "packages/provider-kit/src/process-owner.ts",
      status: "modified",
      additions: 4,
      deletions: 1,
      binary: false,
    },
    {
      path: "apps/daemon/src/cli/kill-all.ts",
      status: "added",
      additions: 2,
      deletions: 0,
      binary: false,
    },
    {
      path: "apps/daemon/src/cli/kill-all.fixtures.ts",
      status: "added",
      additions: 3000,
      deletions: 0,
      binary: false,
    },
  ]);
  daemon.workspace.setGitDiff("ios-tree", patch);
}
