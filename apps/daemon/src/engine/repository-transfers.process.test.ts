import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdir, writeFile } from "node:fs/promises";
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
function runtime(
  f: Awaited<ReturnType<typeof setup>>,
  lookup: () => Promise<readonly GitCredentialHelper[]> = async () => [],
) {
  return new WorkspaceRuntime(f.h.store, f.h.home, () => f.h.clock.now(), {
    git: {
      transportProtocols: ["file"],
      credentialHelperLookup: lookup,
      withRepositoryTransfer: (repository, operation) =>
        f.h.engine.withRepositoryTransfer(repository, operation),
    },
  });
}
function push(f: Awaited<ReturnType<typeof setup>>, workspace: WorkspaceRuntime) {
  return workspace.execute(
    Command.parse({
      id: "user-push",
      deviceId: "device",
      payload: { type: "git.push", threadId: f.id, remote: "origin" },
    }),
  );
}

test("a user's push is refused while an agent turn runs in another worktree of the same repository", async () => {
  const f = await setup();
  const workspace = runtime(f);
  try {
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
    expect(await push(f, workspace)).toMatchObject({
      ok: false,
      error: "git_repository_agent_running",
    });
    await expect(
      workspace.git.fetchBranch({
        repo: f.h.home,
        remote: "origin",
        branch: "main",
        timeoutMs: 10_000,
      }),
    ).rejects.toMatchObject({ code: "repository_agent_running" });
    await expect(git(f.remote, "rev-parse", "--verify", "HEAD")).rejects.toBeDefined();
  } finally {
    await workspace.close();
    await f.h.close();
  }
});

test("a transfer holds provider admission across discovery and execution, including an unregistered linked worktree", async () => {
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
    expect(
      f.h.command({
        type: "thread.prepare",
        threadId: f.peer,
        workspaceId: f.peerWorkspace,
        provider: "codex",
        title: "Prepared peer",
      }),
    ).toMatchObject({ ok: true });
    const pending = push(f, workspace);
    await entered.promise;
    expect(
      f.h.command({
        type: "thread.send",
        threadId: f.id,
        input: [{ type: "text", text: "Race idle session" }],
      }),
    ).toMatchObject({ ok: false });
    f.h.command({
      type: "thread.send",
      threadId: f.peer,
      input: [{ type: "text", text: "Race new session" }],
    });
    await f.h.engine.flush();
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    release.resolve();
    expect(await pending).toMatchObject({ ok: true });
    const queued = f.h.engine.queue(f.peer);
    expect(queued).toMatchObject({ paused: true, reason: "not_sent" });
    expect(
      f.h.command({ type: "queue.resume", threadId: f.peer, expectedRevision: queued.revision }),
    ).toMatchObject({ ok: true });
    await f.h.engine.flush();
    await expect(access(marker)).resolves.toBeUndefined();
    expect(await git(f.remote, "rev-parse", "refs/heads/main")).toBe(
      await git(f.h.home, "rev-parse", "HEAD"),
    );
    await workspace.git.fetchBranch({
      repo: f.h.home,
      remote: "origin",
      branch: "main",
      timeoutMs: 10_000,
    });
    expect(
      await workspace.git.branchHead({ repo: f.h.home, remote: "origin", branch: "main" }),
    ).toBe(await git(f.remote, "rev-parse", "refs/heads/main"));
  } finally {
    release.resolve();
    await workspace.close();
    await f.h.close();
  }
});

test("an agent running in an unrelated repository does not block a user's push", async () => {
  const f = await setup();
  const workspace = runtime(f);
  const other = join(f.h.home, "other-repository");
  try {
    await mkdir(other);
    await git(other, "init", "-b", "main");
    const otherWorkspace = f.h.store.createWorkspace(other, "Unrelated repository");
    expect(
      f.h.command({
        type: "thread.create",
        threadId: f.peer,
        workspaceId: otherWorkspace,
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
    expect(await push(f, workspace)).toMatchObject({ ok: true });
    expect(await git(f.remote, "rev-parse", "refs/heads/main")).toBe(
      await git(f.h.home, "rev-parse", "HEAD"),
    );
  } finally {
    await workspace.close();
    await f.h.close();
  }
});
