import { afterEach, describe, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import type { ChangesStep, MobileFileDiff } from "@ace/ui-core/mobile";
import { ChangesSession, type ChangesOwner } from "./changes.ts";
import { gitAction } from "./git-actions.ts";
import { plainPreview, RecordingSink, sheetFixture, until } from "./sheet-fixture.ts";

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

const big = Array.from({ length: 3000 }, (_, index) => `+line ${index + 1}`).join("\n");
const patch = [
  "diff --git a/src/small.ts b/src/small.ts",
  "index 1111111..2222222 100644",
  "--- a/src/small.ts",
  "+++ b/src/small.ts",
  "@@ -1,3 +1,3 @@",
  " keep",
  "-old",
  "+new",
  ` ${"x".repeat(5000)}`,
  "diff --git a/src/big.ts b/src/big.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/big.ts",
  "@@ -0,0 +1,3000 @@",
  big,
  "",
].join("\n");

async function opened(options: { cutPatch?: boolean } = {}) {
  const { daemon, client } = sheetFixture();
  closers.push(() => client.close());
  daemon.createThread({
    id: "changes",
    workspaceId: "ace",
    title: "Kill-all filters",
    provider: "codex",
    details: {
      branch: "feat/kill-all",
      worktree: "/fake/worktrees/changes",
      head: "b".repeat(40),
      ahead: 0,
      diff: { files: 2, additions: 3001, deletions: 1 },
      repository: { forge: "github", host: "github.com", owner: "arpan404", name: "ace" },
    },
  });
  daemon.apply("changes", [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
  daemon.workspace.setGitStatus("changes", [
    { path: "src/small.ts", status: "modified", additions: 1, deletions: 1, binary: false },
    { path: "src/big.ts", status: "added", additions: 3000, deletions: 0, binary: false },
  ]);
  daemon.workspace.setGitDiff("changes", patch);
  await client.start();
  const lease = client.thread("changes");
  await until(() => lease.store.thread !== undefined, "thread snapshot");
  // The daemon caps `git.diff` at 256 KiB; a cut patch is simulated at the wire boundary.
  const owner: ChangesOwner = {
    command: (payload) => client.command(payload),
    request: (async (input: Parameters<ChangesOwner["request"]>[0]) => {
      const reply = await client.request(input);
      if (options.cutPatch && reply.type === "workspace.result" && reply.result.kind === "gitDiff")
        return { ...reply, result: { ...reply.result, truncated: true } };
      return reply;
    }) as ChangesOwner["request"],
  };
  const sink = new RecordingSink();
  const session = new ChangesSession(owner, lease.store, "changes", 1, sink, plainPreview);
  await until(() => sink.read("changes:summary")?.state === "ready", "first read");
  return { daemon, owner, session, sink };
}
const fileDiff = (sink: RecordingSink) => sink.read("changes:file")?.diff as MobileFileDiff;
const step = (sink: RecordingSink) => sink.read("changes:summary")?.step as ChangesStep;

describe("Changes sheet", () => {
  test("files carry their counts and the totals add up", async () => {
    const { sink } = await opened();
    const summary = sink.read("changes:summary");
    expect(summary?.files).toEqual([
      expect.objectContaining({ path: "src/big.ts", status: "added", additions: 3000 }),
      expect.objectContaining({ path: "src/small.ts", additions: 1, deletions: 1 }),
    ]);
    expect(summary?.totals).toEqual({ files: 2, additions: 3001, deletions: 1 });
    expect(step(sink)).toMatchObject({ kind: "commit", label: "Commit & push", blocked: null });
  });

  test("a large file's diff ships within the budget and says the rest is on the computer", async () => {
    const { session, sink } = await opened();
    session.file("src/big.ts");
    const diff = fileDiff(sink);
    expect(diff.lines.length).toBeLessThanOrEqual(1500);
    expect(diff.hiddenLines).toBeGreaterThan(1400);
    expect(diff.truncated).toBe(true);
    expect(diff.lines[0]).toMatchObject({ kind: "hunk" });
    expect(diff.lines[1]).toMatchObject({ kind: "add", new: 1, text: "line 1" });
  });

  test("a long line is clipped, numbered lines keep their sides, and a small file isn't cut", async () => {
    const { session, sink } = await opened();
    session.file("src/small.ts");
    const diff = fileDiff(sink);
    expect(
      diff.lines.map((line) => [line.kind, line.old, line.new, line.text.slice(0, 4)]),
    ).toEqual([
      ["hunk", null, null, "@@ -"],
      ["context", 1, 1, "keep"],
      ["del", 2, null, "old"],
      ["add", null, 2, "new"],
      ["context", 3, 3, "xxxx"],
    ]);
    expect(diff.lines.at(-1)?.text.length).toBe(1000);
    expect(diff.lines.at(-1)?.clipped).toBe(true);
    expect(diff.hiddenLines).toBe(0);
  });

  test("the file the daemon's cap fell in is marked incomplete", async () => {
    const { session, sink } = await opened({ cutPatch: true });
    session.file("src/small.ts");
    expect(fileDiff(sink).hiddenLines).toBe(0);
    session.file("src/big.ts");
    expect(fileDiff(sink).truncated).toBe(true);
    expect(sink.read("changes:summary")?.patchTruncated).toBe(true);
  });

  test("commit and push goes through guarded git and the next step comes from the daemon", async () => {
    const { owner, session, sink } = await opened();
    gitAction(
      owner,
      session,
      { kind: "commit", message: "Kill-all filters", push: true },
      "r1",
      sink,
      plainPreview,
    );
    await until(() => sink.read("git:r1") !== undefined, "git result");
    expect(sink.read("git:r1")).toMatchObject({ ok: true, message: "Committed and pushed" });
    await until(() => step(sink)?.kind === "create-pr", "next step");
    expect(sink.read("changes:summary")?.totals).toEqual({ files: 0, additions: 0, deletions: 0 });
  });

  test("a commit is refused when someone else committed after the files were read", async () => {
    const { daemon, owner, session, sink } = await opened();
    daemon.workspace.setDetails("changes", { head: "c".repeat(40) });
    await gitAction(
      owner,
      session,
      { kind: "commit", message: "Late", push: false },
      "r2",
      sink,
      plainPreview,
    );
    expect(sink.read("git:r2")).toMatchObject({ ok: false });
    expect(String(sink.read("git:r2")?.message)).not.toContain("git_head_moved");
  });

  test("closing releases the patch and stops following", async () => {
    const { session, sink } = await opened();
    session.file("src/small.ts");
    session.close();
    expect(sink.read("changes:summary")).toBeUndefined();
    expect(sink.read("changes:file")).toBeUndefined();
    expect(session.reads).toBeUndefined();
  });
});
