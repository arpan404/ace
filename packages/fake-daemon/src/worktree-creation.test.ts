import { expect, test } from "vitest";
import { Command, DeviceId, ServerMessage, ThreadId, type ClientMessage } from "@ace/protocol";
import { FakeDaemon } from "./daemon.ts";

function fixture() {
  let time = 1000;
  const jobs: (() => void)[] = [];
  const daemon = new FakeDaemon({
    clock: () => time,
    worktreeCreationSlow: true,
    worktreeCreationSchedule(callback, delay) {
      let active = true;
      jobs.push(() => {
        if (active) {
          time += delay;
          callback();
        }
      });
      return () => {
        active = false;
      };
    },
  });
  const messages: ServerMessage[] = [];
  const connection = daemon.connect({
    send: (text) => messages.push(ServerMessage.parse(JSON.parse(text))),
    close() {},
  });
  const send = (message: ClientMessage) => connection.receive(JSON.stringify(message));
  send({
    type: "hello",
    deviceId: DeviceId.parse("device"),
    token: "fake-token",
    protocolVersion: 1,
  });
  const command = Command.parse({
    id: "create",
    deviceId: "device",
    payload: {
      type: "thread.create",
      threadId: "tree",
      workspaceId: "project",
      provider: "codex",
      mode: "worktree",
      base: { remote: "origin", ref: "main" },
      input: [{ type: "text", text: "Queued first message" }],
    },
  });
  const action = (choice: "get" | "cancel" | "local" | "retry") =>
    send({
      type: "worktree.creation.request",
      requestId: choice,
      commandId: command.id,
      action: choice,
    });
  const advance = () => {
    const job = jobs.shift();
    if (!job) throw new Error("Missing scheduled progress");
    job();
  };
  const drain = () => {
    while (jobs.length) advance();
  };
  const reports = () => messages.filter((message) => message.type === "worktree.creation.progress");
  const view = () => daemon.snapshot({ kind: "thread", threadId: ThreadId.parse("tree") });
  return {
    daemon,
    connection,
    messages,
    send,
    command,
    action,
    advance,
    drain,
    reports,
    view,
  };
}

test("slow fake creation shows the same ordered steps and monotonic percentages as the daemon", async () => {
  const f = fixture();
  try {
    f.send({ type: "command", command: f.command });
    expect(f.view()).toBeUndefined();
    f.drain();
    await Promise.resolve();
    expect([...new Set(f.reports().map((report) => report.step))]).toEqual([
      "preparing",
      "fetching",
      "creating",
      "checking_out",
      "setup",
      "done",
    ]);
    const percentages = f
      .reports()
      .flatMap((report) => (report.percent === undefined ? [] : [report.percent]));
    expect(percentages).toEqual([0, 12, 29, 48, 67, 85, 100]);
    expect(f.reports().at(-1)).toMatchObject({ state: "done", cleanupComplete: true });
    const steps = f.reports().at(-1)?.steps;
    expect((steps?.[1]?.startedAt ?? 0) - (steps?.[0]?.startedAt ?? 0)).toBe(1500);
    expect(f.messages.at(-1)).toMatchObject({ type: "commandResult", ok: true });
  } finally {
    f.connection.close();
  }
});

test("fake cancel retains a draft and local fallback delivers its input once", async () => {
  const f = fixture();
  try {
    f.send({ type: "command", command: f.command });
    while (!f.reports().some((report) => (report.percent ?? 0) > 0)) f.advance();
    f.action("cancel");
    await Promise.resolve();
    expect(f.reports().at(-1)).toMatchObject({ state: "cancelled", actions: ["retry", "local"] });
    expect(f.view()).toBeUndefined();
    f.action("local");
    f.drain();
    await Promise.resolve();
    const view = f.view();
    expect(view?.kind).toBe("thread");
    if (view?.kind !== "thread") throw new Error("Missing fallback thread");
    expect(view.thread.details).toMatchObject({
      mode: "local",
      worktree: "/fake/project",
      worktreeCreation: { state: "local" },
    });
    expect(
      Object.values(view.items).filter((item) => item.type === "message" && item.role === "user"),
    ).toEqual([
      expect.objectContaining({ parts: [{ type: "text", text: "Queued first message" }] }),
    ]);
  } finally {
    f.connection.close();
  }
});

test("fake failure offers retry and local fallback without admitting the input", async () => {
  const f = fixture();
  try {
    const p = f.command.payload;
    if (p.type !== "thread.create") throw new Error("Missing create");
    f.send({
      type: "command",
      command: Command.parse({
        ...f.command,
        payload: { ...p, base: { ref: "missing", remote: "origin" } },
      }),
    });
    f.drain();
    await Promise.resolve();
    expect(f.reports().at(-1)).toMatchObject({
      state: "failed",
      message: "We couldn't create the worktree. Try again or use the local checkout.",
      actions: ["retry", "local"],
    });
    expect(f.view()).toBeUndefined();
    f.action("local");
    await Promise.resolve();
    expect(f.messages.at(-1)).toMatchObject({ type: "commandResult", ok: true });
    expect(f.view()?.kind).toBe("thread");
  } finally {
    f.connection.close();
  }
});
