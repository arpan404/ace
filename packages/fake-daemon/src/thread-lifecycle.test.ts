import { expect, test } from "vitest";
import { Command, ThreadId } from "@ace/protocol";
import { FakeDaemon } from "./daemon.ts";
import { rootAgent, turn } from "./scenarios/facts.ts";

function world() {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.createThread({ id: "thread", workspaceId: "project", provider: "codex", title: "Work" });
  daemon.apply("thread", [
    rootAgent("codex", "/fake/project"),
    turn("root"),
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "approval",
      blocking: true,
      request: {
        kind: "approval",
        title: "Continue?",
        options: [{ id: "yes", label: "Yes", kind: "allow_once" }],
      },
    },
  ]);
  let sequence = 0;
  const command = (payload: unknown, id = `command-${++sequence}`) =>
    daemon.command(Command.parse({ id, deviceId: "device", payload }));
  const view = () => daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("thread") });
  return { daemon, command, view };
}

test("fake force deletion stops waiting agents, closes terminals and remains idempotent", () => {
  const f = world();
  const terminal = f.daemon.terminals.openNow({
    threadId: "thread",
    cwd: "/fake/project",
    cols: 80,
    rows: 24,
  });
  f.command({
    type: "thread.send",
    threadId: "thread",
    input: [{ type: "text", text: "held" }],
    delivery: "queue",
  });
  expect(f.command({ type: "thread.delete", threadId: "thread" })).toMatchObject({
    ok: false,
    error: "thread_busy",
    alive: { agentsRunning: 1, terminalsOpen: 1 },
  });
  const receipt = f.command({ type: "thread.delete", threadId: "thread", force: true }, "force");
  expect(receipt).toMatchObject({ ok: true });
  expect(f.view()).toBeUndefined();
  expect(f.daemon.terminals.list("thread")).toEqual([]);
  const head = f.daemon.head;
  expect(f.command({ type: "thread.delete", threadId: "thread", force: true }, "force")).toEqual(
    receipt,
  );
  f.daemon.terminals.write(terminal.id, "echo should not run\r");
  f.daemon.apply("thread", [turn("root")]);
  expect(f.daemon.head).toBe(head);
});

test("a dead fake provider no longer needs the person, holds queued input and can be plainly deleted", () => {
  const f = world();
  f.command({
    type: "thread.send",
    threadId: "thread",
    input: [{ type: "text", text: "held" }],
    delivery: "queue",
  });
  expect(f.view()).toMatchObject({ thread: { status: { state: "needs_you" } } });
  f.daemon.apply("thread", [{ type: "process.exited", deliberate: false }]);
  expect(f.view()).toMatchObject({ thread: { status: { state: "waiting", on: "queue" } } });
  const view = f.view();
  if (!view || !("interactions" in view)) throw new Error("Missing view");
  expect(Object.values(view.interactions)).toEqual([expect.objectContaining({ state: "expired" })]);
  expect(Object.values(view.items)).toContainEqual(
    expect.objectContaining({ type: "notice", code: "agent_stopped" }),
  );
  expect(f.command({ type: "thread.delete", threadId: "thread" }).ok).toBe(true);
  expect(f.view()).toBeUndefined();
});

test("an exited fake terminal permits deletion without an explicit terminal close", () => {
  const daemon = new FakeDaemon({ clock: () => 1000 });
  daemon.createThread({ id: "thread", workspaceId: "project", provider: "codex", title: "Shell" });
  const terminal = daemon.terminals.openNow({
    threadId: "thread",
    cwd: "/fake/project",
    cols: 80,
    rows: 24,
  });
  daemon.terminals.write(terminal.id, "exit\r");
  expect(
    daemon.command(
      Command.parse({
        id: "delete",
        deviceId: "device",
        payload: { type: "thread.delete", threadId: "thread" },
      }),
    ).ok,
  ).toBe(true);
  expect(daemon.terminals.list("thread")).toEqual([]);
});
