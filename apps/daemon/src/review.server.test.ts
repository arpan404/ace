import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { Command } from "@ace/protocol";
import { createDaemonReview } from "./review.ts";
import { fixture } from "./socket-test-support.ts";
import { setup } from "./remote-test-support.ts";

it("routes authenticated review reads through the worker and rejects unregistered repositories", async () => {
  const dir = await mkdtemp(join(tmpdir(), "ace-review-server-"));
  let review: ReturnType<typeof createDaemonReview> | undefined;
  const f = await fixture({
    review: {
      handle: (command) => {
        if (!review) throw new Error("Missing review");
        return review.handle(command);
      },
    },
  });
  review = createDaemonReview(dir, f.store);
  try {
    const client = await f.connect();
    await client.next();
    client.send({
      type: "command",
      command: Command.parse({ id: "list", deviceId: "device", payload: { type: "review.list" } }),
    });
    const listed = await client.next();
    expect(listed).toMatchObject({ type: "commandResult", ok: true, review: { sessions: [] } });
    client.send({
      type: "command",
      command: Command.parse({
        id: "list",
        deviceId: "device",
        payload: { type: "thread.archive", threadId: f.thread.id },
      }),
    });
    expect(await client.next()).toEqual(listed);
    expect(f.store.getThread(f.thread.id)?.archivedAt).toBeUndefined();
    client.send({
      type: "command",
      command: Command.parse({
        id: "open",
        deviceId: "device",
        payload: {
          type: "review.open",
          source: {
            workspaceId: "missing",
            from: { kind: "commit", ref: "HEAD" },
            to: { kind: "working-tree" },
          },
        },
      }),
    });
    expect(await client.next()).toMatchObject({
      type: "commandResult",
      ok: false,
      error: "review_workspace_not_found",
    });
  } finally {
    await review.close();
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});
it("a read-only paired device can list reviews but cannot change their status", async () => {
  const f = await setup({
    review: {
      async handle(command) {
        return { commandId: command.id, ok: true, review: { sessions: [] } };
      },
    },
  });
  const credential = await f.pair(["read"]);
  const ticket = await f.ticket(credential.token);
  const client = await f.connectTicket(credential.device.id, ticket.ticket);
  await client.next();
  client.send({
    type: "command",
    command: Command.parse({
      id: "read",
      deviceId: credential.device.id,
      payload: { type: "review.list" },
    }),
  });
  expect(await client.next()).toMatchObject({
    type: "commandResult",
    ok: true,
    review: { sessions: [] },
  });
  client.send({
    type: "command",
    command: Command.parse({
      id: "mutate",
      deviceId: credential.device.id,
      payload: { type: "review.status", sessionId: "session", status: "approved" },
    }),
  });
  expect(await client.next()).toMatchObject({ type: "error", code: "forbidden" });
});

it("daemon review follows a thread's isolated worktree and refreshes when its fix completes", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdir, writeFile } = await import("node:fs/promises");
  const { startDaemon, readConfig, createDevThread } = await import("./index.ts");
  const { stubHandler } = await import("./commands.ts");
  const directory = await mkdtemp(join(tmpdir(), "ace-review-worktree-"));
  const root = join(directory, "repo");
  const worktree = join(directory, "thread");
  await mkdir(root);
  const git = (...args: string[]) => promisify(execFile)("git", args, { cwd: root });
  let daemon: Awaited<ReturnType<typeof startDaemon>> | undefined;
  let threadId: string | undefined;
  try {
    await git("init", "-q");
    await git("config", "user.name", "Review");
    await git("config", "user.email", "review@example.invalid");
    await writeFile(join(root, "file.ts"), "before\noriginal\nafter\n");
    await git("add", ".");
    await git("commit", "-qm", "base");
    await git("worktree", "add", "--detach", worktree, "HEAD");
    await writeFile(join(worktree, "file.ts"), "before\nwrong\nafter\n");
    daemon = await startDaemon(
      readConfig({ ACE_HOME: join(directory, "daemon"), ACE_PORT: "0", ACE_LOG_LEVEL: "silent" }),
      stubHandler(),
      [],
      {},
      [],
      { threadWorktree: (id) => (id === threadId ? worktree : undefined) },
    );
    const workspaceId = daemon.store.createWorkspace(root, "Review workspace");
    threadId = createDevThread(daemon.store, workspaceId).id;
    let serial = 0;
    const send = (payload: unknown) => {
      if (!daemon) throw new Error("Missing daemon");
      return daemon.review.handle(
        Command.parse({ id: `review-command-${++serial}`, deviceId: "engine", payload }),
      );
    };
    const opened = await send({
      type: "review.open",
      source: {
        workspaceId,
        threadId,
        from: { kind: "commit", ref: "HEAD" },
        to: { kind: "working-tree" },
      },
    });
    const sessionId = opened.review?.session?.id;
    if (!sessionId) throw new Error("Missing review session");
    const comment = await send({
      type: "review.comment",
      sessionId,
      position: { file: "file.ts", side: "new", start: 2, end: 2 },
      text: "Fix isolated worktree",
    });
    expect(comment.review?.comment?.anchor.fingerprint.lines).toEqual(["wrong"]);
    await writeFile(join(worktree, "file.ts"), "before\nwrong fixed\nafter\n");
    expect((await daemon.review.afterFix(sessionId, "isolated-fix")).ok).toBe(true);
    const listed = await send({ type: "review.list", sessionId });
    expect(listed.review?.comments?.[0]?.anchor.state).toBe("addressed-pending-review");
  } finally {
    await daemon?.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

it("a pending daemon receipt recovers its durable worker result without replaying an effect", async () => {
  const directory = await mkdtemp(join(tmpdir(), "ace-review-receipt-"));
  let review: ReturnType<typeof createDaemonReview> | undefined;
  const f = await fixture({
    review: {
      handle: (command) => {
        if (!review) throw new Error("Missing review");
        return review.handle(command);
      },
      recover: (command) => {
        if (!review) throw new Error("Missing review");
        return review.recover(command);
      },
    },
  });
  review = createDaemonReview(directory, f.store);
  try {
    const command = Command.parse({
      id: "recover",
      deviceId: "device",
      payload: { type: "review.list" },
    });
    const completed = await review.handle(command);
    f.store.recordCommand(command.id, command.deviceId, () => ({
      commandId: command.id,
      ok: false,
      error: "review_pending",
    }));
    const client = await f.connect();
    await client.next();
    client.send({ type: "command", command });
    expect(await client.next()).toEqual({ type: "commandResult", ...completed });
    client.send({
      type: "command",
      command: Command.parse({
        id: "recover",
        deviceId: "device",
        payload: { type: "thread.archive", threadId: f.thread.id },
      }),
    });
    expect(await client.next()).toEqual({ type: "commandResult", ...completed });
    expect(f.store.getThread(f.thread.id)?.archivedAt).toBeUndefined();
  } finally {
    await review.close();
    await f.close();
    await rm(directory, { recursive: true, force: true });
  }
});
