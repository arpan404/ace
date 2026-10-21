import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { ThreadId, type CommandPayload, type ForgePrRef } from "@ace/protocol";
import { command } from "./thread-creation-test-support.ts";
import { prDaemon, run } from "./pr-worktree-test-support.ts";

/** A PR task whose base gained a commit that changes the same file the PR adds. */
async function conflictingPr() {
  const d = await prDaemon();
  const id = ThreadId.parse("pr-conflicts");
  expect(await d.create(id)).toMatchObject({ ok: true });
  await d.h.engine.flush();
  const path = d.h.store.getThread(id)?.details?.worktree ?? "";
  await writeFile(join(d.h.home, "pr.txt"), "Main content\n");
  await run(d.h.home, "add", "pr.txt");
  await run(d.h.home, "commit", "-m", "Main work", "--", "pr.txt");
  await run(d.h.home, "push", "origin", "main");
  const main = await run(d.h.home, "rev-parse", "HEAD");
  const pr = d.selection.ref;
  let sent = 0;
  const step = (stepInput: Extract<CommandPayload, { type: "git.conflicts" }>["step"], ref = pr) =>
    command(d.client, `conflicts-${++sent}`, {
      type: "git.conflicts",
      threadId: id,
      pr: ref,
      step: stepInput,
    });
  const read = async (ref: ForgePrRef = pr) => {
    const result = await d.runtime.read({
      type: "workspace.request",
      requestId: `read-${++sent}`,
      operation: { op: "git.conflicts", threadId: id, pr: ref },
    });
    if (result.result.kind !== "gitConflicts") throw new Error("Expected conflicts");
    return result.result.conflicts;
  };
  return { d, id, path, main, step, read };
}

test("a PR task merges its fetched base, resolves the conflict by hand and commits the merge", async () => {
  const { d, path, main, step, read } = await conflictingPr();
  try {
    expect(await read()).toMatchObject({ head: d.head, merging: false, files: [] });
    expect(await step({ action: "start", expectedHead: d.head })).toMatchObject({
      ok: true,
      code: "merge_conflicts",
    });
    const conflicts = await read();
    const file = conflicts?.files[0];
    expect(file).toMatchObject({
      path: "pr.txt",
      stages: { base: false, ours: true, theirs: true },
      content: {
        kind: "text",
        segments: [{ kind: "conflict", ours: "PR-only content\n", theirs: "Main content\n" }],
      },
    });
    if (file?.content.kind !== "text") throw new Error("Expected text");
    expect(
      await step({
        action: "write",
        path: "pr.txt",
        content: "PR-only content\nMain content\n",
        revision: file.content.revision,
      }),
    ).toMatchObject({ ok: true, code: "conflict_resolved" });
    const result = await step({ action: "commit", expectedHead: d.head });
    expect(result).toMatchObject({ ok: true });
    const commit = result.type === "commandResult" ? (result.commit ?? "") : "";
    expect(await run(path, "rev-parse", "HEAD", `${commit}^1`, `${commit}^2`)).toBe(
      `${commit}\n${d.head}\n${main}`,
    );
    expect(await readFile(join(path, "pr.txt"), "utf8")).toBe("PR-only content\nMain content\n");
    // The project's own checkout, with the person's edit, is untouched.
    expect(await readFile(join(d.h.home, "file.txt"), "utf8")).toBe("Personal dirty edit\n");
  } finally {
    await d.close();
  }
});

test("conflict steps refuse a checkout that holds another pull request and a dirty checkout", async () => {
  const { d, path, step, read } = await conflictingPr();
  try {
    const other = { ...d.selection.ref, number: 8 };
    expect(await read(other)).toBeNull();
    expect(await step({ action: "start", expectedHead: d.head }, other)).toMatchObject({
      ok: false,
      error: "git_pr_head_unavailable",
    });
    await writeFile(join(path, "pr.txt"), "Unsaved work\n");
    expect(await read()).toMatchObject({ dirty: true, merging: false });
    expect(await step({ action: "start", expectedHead: d.head })).toMatchObject({
      ok: false,
      error: "git_dirty_worktree",
    });
    expect(await readFile(join(path, "pr.txt"), "utf8")).toBe("Unsaved work\n");
    expect(await read()).toMatchObject({ merging: false });
  } finally {
    await d.close();
  }
});
