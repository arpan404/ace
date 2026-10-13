import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
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
  return { h, frames, id, peer, peerRoot, peerWorkspace, remote };
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
// A command ID is an idempotency key: a retry after a refusal is a new push with a new ID.
function push(f: Awaited<ReturnType<typeof setup>>, workspace: WorkspaceRuntime, id = "user-push") {
  return workspace.execute(
    Command.parse({
      id,
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

test("corrupted metadata in an unrelated active linked worktree does not fence pushes or provider admission", async () => {
  const f = await setup();
  const workspace = runtime(f);
  const unrelated = await mkdtemp(join(tmpdir(), "ace-unrelated-repository-"));
  const other = join(unrelated, "repository");
  try {
    await mkdir(other);
    await git(other, "init", "-b", "main");
    await git(
      other,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgSign=false",
      "commit",
      "--allow-empty",
      "-m",
      "Initial",
    );
    const linked = join(unrelated, "linked-checkout");
    await git(other, "worktree", "add", "-b", "other-peer", linked, "HEAD");
    const otherWorkspace = f.h.store.createWorkspace(linked, "Unrelated linked worktree");
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
    await writeFile(join(linked, ".git"), "malformed agent-written metadata\n");
    expect(await push(f, workspace)).toMatchObject({ ok: true });
    expect(await git(f.remote, "rev-parse", "refs/heads/main")).toBe(
      await git(f.h.home, "rev-parse", "HEAD"),
    );
    // A second transfer and a provider dispatch both use the durable admission owner.
    // Either would fail if discovery accidentally left a permanent target reservation.
    expect(await push(f, workspace)).toMatchObject({ ok: true });
    expect(
      f.h.command({
        type: "thread.send",
        threadId: f.id,
        input: [{ type: "text", text: "Resume healthy repository" }],
      }),
    ).toMatchObject({ ok: true });
    await f.h.engine.flush();
    expect(f.h.store.getThread(f.id)?.status.state).toBe("working");
  } finally {
    await workspace.close();
    await f.h.close();
    await rm(unrelated, { recursive: true, force: true });
  }
});

test("a push refuses known active work while provider output keeps streaming into a blocked mailbox", async () => {
  const f = await setup();
  const workspace = runtime(f);
  const timeout = new AbortController();
  let stream: ReturnType<typeof setInterval> | undefined;
  try {
    expect(
      f.h.command({
        type: "thread.create",
        threadId: f.peer,
        workspaceId: f.peerWorkspace,
        provider: "codex",
        input: [{ type: "text", text: "First peer turn" }],
      }),
    ).toMatchObject({ ok: true });
    await f.h.engine.flush();
    expect(
      f.h.command({
        type: "thread.send",
        threadId: f.peer,
        input: [{ type: "text", text: "Keep streaming" }],
      }),
    ).toMatchObject({ ok: true });
    await f.h.engine.flush();
    expect(f.h.store.getThread(f.peer)?.status.state).toBe("working");
    const context = f.h.contexts.at(-1);
    if (!context) throw new Error("Missing provider context");
    f.h.store.setHistoryWriting(true);
    const emit = () =>
      context.onFrame(
        f.frames.frame({
          type: "item.delta",
          agent: "root",
          item: "stream",
          field: "text",
          append: "More output\n",
        }),
      );
    emit();
    stream = setInterval(emit, 5);
    // Drive the Git push directly: a command receipt is a store write, and store writes
    // queue behind history publication by design. The refusal itself must not wait.
    await expect(
      Promise.race([
        workspace.git.push({ worktree: f.h.home, remote: "origin" }),
        delay(2_000, undefined, { signal: timeout.signal }).then(() => {
          throw new Error("Push waited for a live provider mailbox");
        }),
      ]),
    ).rejects.toMatchObject({ code: "repository_agent_running" });
    await expect(git(f.remote, "rev-parse", "--verify", "HEAD")).rejects.toBeDefined();
  } finally {
    timeout.abort();
    clearInterval(stream);
    f.h.store.setHistoryWriting(false);
    await workspace.close();
    await f.h.close();
  }
});

test("unsettled activity reconciliation refuses within its deadline and releases provider admission", async () => {
  const f = await setup();
  const workspace = runtime(f);
  try {
    // The provider is idle, but its mailbox cannot reconcile during history publication.
    f.h.store.setHistoryWriting(true);
    const waiting = f.h.clock.waitForDelay(1_000);
    const pending = push(f, workspace);
    await waiting;
    f.h.clock.advance(f.h.clock.now() + 1_000);
    // The refusal is decided at the deadline. Its command receipt is a store write that
    // queues behind history publication, so release publication before reading it; a
    // fence that had waited for the mailbox instead would now push successfully.
    f.h.store.setHistoryWriting(false);
    expect(await pending).toMatchObject({ ok: false, error: "git_repository_agent_running" });
    await f.h.engine.flush();
    expect(await push(f, workspace, "user-push-retry")).toMatchObject({ ok: true });
    expect(
      f.h.command({
        type: "thread.send",
        threadId: f.id,
        input: [{ type: "text", text: "Admission recovered" }],
      }),
    ).toMatchObject({ ok: true });
    await f.h.engine.flush();
    expect(f.h.store.getThread(f.id)?.status.state).toBe("working");
  } finally {
    f.h.store.setHistoryWriting(false);
    await workspace.close();
    await f.h.close();
  }
});

test("target metadata discovery failure releases an undispatched transfer reservation", async () => {
  const f = await setup();
  const workspace = runtime(f);
  const dot = join(f.peerRoot, ".git");
  const original = await readFile(dot, "utf8");
  try {
    expect(
      f.h.command({
        type: "thread.create",
        threadId: f.peer,
        workspaceId: f.peerWorkspace,
        provider: "codex",
        input: [{ type: "text", text: "Idle linked peer" }],
      }),
    ).toMatchObject({ ok: true });
    await f.h.engine.flush();
    await writeFile(dot, "malformed target metadata\n");
    expect(await push(f, workspace)).toMatchObject({ ok: false, error: "git_quarantined" });
    await writeFile(dot, original);
    expect(await push(f, workspace, "user-push-retry")).toMatchObject({ ok: true });
    expect(
      f.h.command({
        type: "thread.send",
        threadId: f.id,
        input: [{ type: "text", text: "Target admission recovered" }],
      }),
    ).toMatchObject({ ok: true });
    await f.h.engine.flush();
    expect(f.h.store.getThread(f.id)?.status.state).toBe("working");
  } finally {
    await writeFile(dot, original);
    await workspace.close();
    await f.h.close();
  }
});
