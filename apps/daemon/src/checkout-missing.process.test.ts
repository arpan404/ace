import { realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { ThreadDetails, ThreadId } from "@ace/protocol";
import { fixture, git } from "./workspace-move-test-support.ts";

/*
 * A thread's worktree folder removed outside ace, against real Git: what the daemon reports of
 * its branch, where Recreate and Move to local put the thread, and a message sent meanwhile.
 * Real Git is the point: worktree registration, pruning and branch state are Git's to decide.
 */

type Fixture = Awaited<ReturnType<typeof fixture>>;

/** A thread moved into its own worktree, its branch renamed as a person would. */
async function inWorktree(f: Fixture, branch: string) {
  const thread = f.local();
  await f.h.engine.flush();
  expect(
    await f.run({ type: "thread.workspace.set", threadId: thread, mode: "worktree" }),
  ).toMatchObject({ ok: true });
  const tree = f.h.store.getThread(thread)?.details?.worktree ?? "";
  await git(tree, "branch", "-m", branch);
  expect(await f.runtime.details(thread)).toMatchObject({ branch });
  return { thread, tree };
}

const recreate = (f: Fixture, thread: ThreadId) =>
  f.run({ type: "thread.workspace.set", threadId: thread, mode: "worktree" });
const details = (f: Fixture, thread: ThreadId): ThreadDetails | undefined =>
  f.h.store.getThread(thread)?.details;

test("a removed worktree whose branch survives is remade on that branch, not a new one", async () => {
  const f = await fixture();
  try {
    const { thread, tree } = await inWorktree(f, "ui/atmos");
    await rm(tree, { recursive: true, force: true });
    expect(await f.runtime.details(thread)).toMatchObject({
      worktreeMissing: true,
      checkoutMissing: { kind: "worktree", branch: { name: "ui/atmos", state: "free" } },
    });
    expect(await recreate(f, thread)).toMatchObject({ ok: true });
    expect(details(f, thread)).toMatchObject({ worktree: tree, branch: "ui/atmos" });
    expect(details(f, thread)?.checkoutMissing).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("a worktree removed with its branch starts again from its base branch as it is now", async () => {
  const f = await fixture();
  try {
    const first = await git(f.h.home, "rev-parse", "HEAD");
    const { thread, tree } = await inWorktree(f, "ui/atmos");
    // The thread began from main at `first`; main has moved on since.
    const current = details(f, thread) ?? {};
    f.h.store.appendEvents(
      thread,
      [
        {
          type: "thread.client.updated",
          changes: { details: { ...current, base: { ref: "main", head: first } } },
        },
      ],
      1,
    );
    await git(f.h.home, "worktree", "remove", "--force", tree);
    await git(f.h.home, "branch", "-D", "ui/atmos");
    await writeFile(join(f.h.home, "file.txt"), "merged\n");
    await git(f.h.home, "commit", "-am", "Merged ui/atmos");
    const main = await git(f.h.home, "rev-parse", "HEAD");
    expect((await f.runtime.details(thread)).checkoutMissing).toEqual({
      kind: "worktree",
      branch: { name: "ui/atmos", state: "gone" },
    });
    expect(await recreate(f, thread)).toMatchObject({ ok: true });
    const remade = details(f, thread);
    expect(remade?.branch).toMatch(/^ace\//);
    expect(remade?.head).toBe(main);
  } finally {
    await f.close();
  }
});

test("a removed worktree whose branch is now in the local checkout moves there and stays on it", async () => {
  const f = await fixture();
  try {
    const { thread, tree } = await inWorktree(f, "fix");
    await git(f.h.home, "worktree", "remove", "--force", tree);
    await git(f.h.home, "checkout", "fix");
    expect((await f.runtime.details(thread)).checkoutMissing).toEqual({
      kind: "worktree",
      branch: { name: "fix", state: "elsewhere", holder: "local" },
    });
    expect(
      await f.run({ type: "thread.workspace.set", threadId: thread, mode: "local" }),
    ).toMatchObject({ ok: true });
    expect(details(f, thread)).toMatchObject({
      mode: "local",
      worktree: await realpath(f.h.home),
      branch: "fix",
    });
    expect(details(f, thread)?.worktreeMissing).toBeUndefined();
  } finally {
    await f.close();
  }
});

test("a message sent after the worktree was removed waits, then sends once the thread moves", async () => {
  const f = await fixture();
  try {
    const { thread, tree } = await inWorktree(f, "ui/atmos");
    await rm(tree, { recursive: true, force: true });
    expect(f.send(thread, "after removal")).toMatchObject({ ok: true });
    await f.h.engine.flush();
    expect(f.h.inputs.some((input) => input.text.endsWith("after removal"))).toBe(false);
    expect(f.h.engine.queue(thread)).toMatchObject({
      paused: true,
      lastFailure: { code: "worktree_missing" },
    });
    expect(details(f, thread)).toMatchObject({
      worktreeMissing: true,
      checkoutMissing: { kind: "worktree", branch: { name: "ui/atmos", state: "free" } },
    });
    // The waiting message doesn't hold the checkout: the thread can still move.
    expect(
      await f.run({ type: "thread.workspace.set", threadId: thread, mode: "local" }),
    ).toMatchObject({ ok: true });
    await f.h.engine.flush();
    expect(f.h.inputs.at(-1)?.text.endsWith("after removal")).toBe(true);
    expect(f.h.sessions.at(-1)?.context.cwd).toBe(await realpath(f.h.home));
    expect(f.h.engine.queue(thread)).toMatchObject({ paused: false, lastFailure: null });
  } finally {
    await f.close();
  }
});
