import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { Command, ThreadId } from "@ace/protocol";
import { WorkspaceRuntime } from "../workspace-runtime.ts";
import type { GitCredentialHelper } from "@ace/git";
import { harness, scriptFrames, start, end } from "./test-support.ts";

const execute = promisify(execFile);
async function git(cwd: string, ...args: string[]) {
  return (await execute("git", args, { cwd, encoding: "utf8" })).stdout.trim();
}
async function setup() {
  const frames = scriptFrames();
  const h = await harness(
    [
      { on: "send", frames: [frames.frame(start, end)] },
      { on: "send", frames: [frames.frame(start)] },
    ],
    frames,
  );
  await git(h.home, "init", "-b", "main");
  await git(h.home, "config", "user.name", "Test");
  await git(h.home, "config", "user.email", "test@example.invalid");
  await writeFile(join(h.home, "tracked.txt"), "Tracked content\n");
  await git(h.home, "add", "tracked.txt");
  await git(h.home, "-c", "commit.gpgSign=false", "commit", "-m", "Initial");
  const remote = join(h.home, "remote.git"),
    peerRoot = join(h.home, "linked-checkout");
  await git(h.home, "init", "--bare", remote);
  await git(h.home, "remote", "add", "origin", `file://${remote}`);
  await git(h.home, "worktree", "add", "-b", "peer", peerRoot, "HEAD");
  const id = await h.create();
  const peerWorkspace = h.store.createWorkspace(peerRoot, "Linked worktree");
  const peer = ThreadId.parse("linked-peer");
  return { h, id, peer, peerRoot, peerWorkspace, remote };
}
type Fixture = Awaited<ReturnType<typeof setup>>;
function runtime(
  f: Fixture,
  lookup: () => Promise<readonly GitCredentialHelper[]> = async () => [],
) {
  return new WorkspaceRuntime(f.h.store, f.h.home, () => f.h.clock.now(), {
    git: { transportProtocols: ["file"], credentialHelperLookup: lookup },
  });
}
function push(f: Fixture, workspace: WorkspaceRuntime) {
  return workspace.execute(
    Command.parse({
      id: "user-push",
      deviceId: "device",
      payload: { type: "git.push", threadId: f.id, remote: "origin" },
    }),
  );
}
/** Starts the linked worktree's agent on a turn that keeps running. */
async function keepPeerWorking(f: Fixture) {
  expect(
    f.h.command({
      type: "thread.create",
      threadId: f.peer,
      workspaceId: f.peerWorkspace,
      provider: "codex",
      input: [{ type: "text", text: "First turn" }],
    }),
  ).toMatchObject({ ok: true });
  await f.h.engine.flush();
  expect(
    f.h.command({
      type: "thread.send",
      threadId: f.peer,
      input: [{ type: "text", text: "Keep working" }],
    }),
  ).toMatchObject({ ok: true });
  await f.h.engine.flush();
  expect(f.h.store.getThread(f.peer)?.status.state).toBe("working");
}

test("a push and a fetch from the main checkout succeed while an agent works in a linked worktree", async () => {
  const f = await setup();
  const workspace = runtime(f);
  try {
    await keepPeerWorking(f);
    expect(await push(f, workspace)).toMatchObject({ ok: true });
    const head = await git(f.h.home, "rev-parse", "HEAD");
    expect(await git(f.remote, "rev-parse", "refs/heads/main")).toBe(head);
    await workspace.git.fetchBranch({
      repo: f.h.home,
      remote: "origin",
      branch: "main",
      timeoutMs: 10_000,
    });
    expect(
      await workspace.git.branchHead({ repo: f.h.home, remote: "origin", branch: "main" }),
    ).toBe(head);
    // The agent's turn is untouched by the transfers next to it.
    expect(f.h.store.getThread(f.peer)?.status.state).toBe("working");
  } finally {
    await workspace.close();
    await f.h.close();
  }
});

test("a fetch from a linked worktree succeeds while an agent works in that worktree", async () => {
  const f = await setup();
  const workspace = runtime(f);
  try {
    await keepPeerWorking(f);
    await git(f.h.home, "push", "origin", "main");
    // The remote moves on without this repository seeing it, so only the fetch can bring it in.
    const moved = await git(
      f.remote,
      "-c",
      "user.name=Remote",
      "-c",
      "user.email=remote@example.invalid",
      "commit-tree",
      "main^{tree}",
      "-p",
      "main",
      "-m",
      "Remote change",
    );
    await git(f.remote, "update-ref", "refs/heads/main", moved);
    await workspace.git.fetchBranch({
      repo: f.peerRoot,
      remote: "origin",
      branch: "main",
      timeoutMs: 10_000,
    });
    expect(
      await workspace.git.branchHead({ repo: f.peerRoot, remote: "origin", branch: "main" }),
    ).toBe(moved);
  } finally {
    await workspace.close();
    await f.h.close();
  }
});

test("an agent in a linked worktree starts its turn while a push from the main checkout is in flight", async () => {
  const f = await setup();
  const entered = Promise.withResolvers<void>(),
    release = Promise.withResolvers<void>();
  const workspace = runtime(f, async () => {
    entered.resolve();
    await release.promise;
    return [];
  });
  const marker = join(f.h.home, "peer-provider-opened");
  const original = f.h.registry.get("codex");
  f.h.registry.register(
    {
      ...original.adapter,
      async openSession(context) {
        if (context.cwd === f.peerRoot) await writeFile(marker, "opened");
        return original.adapter.openSession(context);
      },
    },
    { installed: true, auth: "logged_in", loginHint: "unused" },
  );
  try {
    const pending = push(f, workspace);
    await entered.promise;
    expect(
      f.h.command({
        type: "thread.create",
        threadId: f.peer,
        workspaceId: f.peerWorkspace,
        provider: "codex",
        input: [{ type: "text", text: "Start during the push" }],
      }),
    ).toMatchObject({ ok: true });
    await f.h.engine.flush();
    await expect(access(marker)).resolves.toBeUndefined();
    release.resolve();
    expect(await pending).toMatchObject({ ok: true });
    expect(await git(f.remote, "rev-parse", "refs/heads/main")).toBe(
      await git(f.h.home, "rev-parse", "HEAD"),
    );
  } finally {
    release.resolve();
    await workspace.close();
    await f.h.close();
  }
});
