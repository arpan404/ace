import { expect, test } from "vitest";
import { Command, ThreadId, WorkspaceId } from "@ace/protocol";
import { FakeDaemon } from "./daemon.ts";
import * as facts from "./scenarios/facts.ts";

function world() {
  let at = 1000;
  const daemon = new FakeDaemon({ clock: () => ++at });
  daemon.createThread({ id: "source", workspaceId: "old", title: "History", provider: "codex" });
  daemon.createThread({
    id: "destination",
    workspaceId: "new",
    title: "Target",
    provider: "codex",
  });
  let sequence = 0;
  const command = (payload: unknown, id = `command-${++sequence}`) =>
    daemon.command(Command.parse({ id, deviceId: "device", payload }));
  return { daemon, command };
}

test("the fake moves a thread's history and pin while clearing old repository details", () => {
  const f = world();
  f.command({ type: "thread.pin", threadId: "source", pinned: true, order: 512.5 });
  f.daemon.apply("source", [facts.rootAgent("codex")]);
  const before = view(f.daemon);
  const payload = {
    type: "thread.move" as const,
    threadId: "source",
    workspaceId: WorkspaceId.parse("new"),
  };
  expect(f.command(payload, "move")).toMatchObject({ ok: true, threadId: "source" });
  expect(view(f.daemon)?.thread).toMatchObject({
    workspaceId: "new",
    pinned: true,
    pinOrder: 512.5,
    details: { mode: "local", workspace: { id: "new" }, worktree: "/fake/new" },
  });
  expect(view(f.daemon)?.items).toEqual(before?.items);
  const seq = f.daemon.head;
  expect(f.command(payload, "move")).toMatchObject({ ok: true });
  expect(f.daemon.head).toBe(seq);
});

test("the fake refuses missing projects and a tree that is still working", () => {
  const f = world();
  expect(
    f.command({
      type: "thread.move",
      threadId: "source",
      workspaceId: WorkspaceId.parse("missing"),
    }),
  ).toMatchObject({ ok: false, error: "workspace_not_found" });
  f.daemon.apply("source", [facts.rootAgent("codex"), facts.turn("root")]);
  expect(
    f.command({ type: "thread.move", threadId: "source", workspaceId: WorkspaceId.parse("new") }),
  ).toMatchObject({ ok: false, error: "thread_busy" });
  expect(view(f.daemon)?.thread.workspaceId).toBe("old");
});

function view(daemon: FakeDaemon) {
  const snapshot = daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("source") });
  if (!snapshot || !("thread" in snapshot)) throw new Error("Thread snapshot missing");
  return snapshot;
}
