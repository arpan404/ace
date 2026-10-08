import { expect, test } from "vitest";
import { Command, ThreadId, type WorktreeBase } from "@ace/protocol";
import { FakeDaemon } from "./daemon.ts";

function world() {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  let sequence = 0;
  const create = (base: WorktreeBase, type: "thread.create" | "thread.prepare" = "thread.create") =>
    daemon.command(
      Command.parse({
        id: `create-${++sequence}`,
        deviceId: "device",
        payload: {
          type,
          threadId: `thread-${sequence}`,
          workspaceId: "workspace",
          provider: "codex",
          mode: "worktree",
          base,
          // Clients send the legacy name too; `base` decides.
          baseBranch: "develop",
          ...(type === "thread.create"
            ? { input: [{ type: "text", text: "Start" }] }
            : { title: "Prepared" }),
        },
      }),
    );
  const details = (threadId: string | undefined) => {
    const view = daemon.snapshot({
      kind: "thread",
      threadId: ThreadId.parse(threadId ?? "missing"),
    });
    return view?.kind === "thread" ? view.thread.details : undefined;
  };
  return { daemon, create, details };
}

test("a worktree from a remote base records the fetched base on a branch of its own", () => {
  const f = world();
  const created = f.create({ ref: "main", remote: "origin" });
  expect(created).toMatchObject({ ok: true });
  const details = f.details(created.threadId);
  expect(details).toMatchObject({
    baseBranch: "origin/main",
    base: {
      ref: "main",
      remote: "origin",
      fetch: "fetched",
      head: expect.stringMatching(/^[a-f0-9]{40}$/),
    },
  });
  expect(details?.branch).toMatch(/^ace\//);
  const prepared = f.create({ ref: "develop" }, "thread.prepare");
  expect(f.details(prepared.threadId)).toMatchObject({
    baseBranch: "develop",
    base: { ref: "develop" },
  });
  expect(f.details(prepared.threadId)?.base).not.toHaveProperty("fetch");
});

test("with the remote unreachable a listed branch uses its cached copy and an unlisted one fails", () => {
  const f = world();
  f.daemon.setRemoteReachable(false);
  const cached = f.create({ ref: "release/0.9", remote: "origin" });
  expect(f.details(cached.threadId)?.base).toMatchObject({
    ref: "release/0.9",
    remote: "origin",
    fetch: "unreachable",
  });
  expect(f.create({ ref: "never-fetched", remote: "origin" })).toMatchObject({
    ok: false,
    error: "worktree_base_unreachable",
  });
  f.daemon.setRemoteReachable(true);
  expect(f.create({ ref: "never-fetched", remote: "origin" })).toMatchObject({
    ok: false,
    error: "worktree_base_not_found",
  });
});

test("a prepared worktree names its branch from the readable thread title", () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  const result = daemon.command(
    Command.parse({
      id: "title",
      deviceId: "device",
      payload: {
        type: "thread.prepare",
        threadId: "thread-title",
        workspaceId: "workspace",
        provider: "codex",
        mode: "worktree",
        title: "Fix Réplay: restart budget!",
        base: { ref: "main" },
      },
    }),
  );
  expect(result.ok).toBe(true);
  const view = daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread-title") });
  expect(view?.kind === "thread" && view.thread.details?.branch).toBe(
    "ace/fix-replay-restart-budget",
  );
});
