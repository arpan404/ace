import { getEventListeners } from "node:events";
import { ThreadId, type ContentPart } from "@ace/protocol";
import type { Frame, SessionContext } from "@ace/engine-api";
import { describe, expect, it } from "vitest";
import { createScriptedAdapter, type ScriptedStep } from "./index.ts";
import { capabilities, createTranslator } from "./translator.test-helper.ts";

const frame = (seq: number): Frame => ({
  seq,
  t: seq * 10,
  dir: "recv",
  channel: "fake",
  data: { seq },
});
function setup(steps: ScriptedStep[]) {
  const frames: Frame[] = [];
  const exits: Parameters<SessionContext["onExit"]>[0][] = [];
  const controller = new AbortController();
  const ctx: SessionContext = {
    threadId: ThreadId.parse("test-thread"),
    cwd: "/fixture",
    signal: controller.signal,
    onFrame: (value) => frames.push(value),
    onExit: (value) => exits.push(value),
  };
  const adapter = createScriptedAdapter({
    provider: "codex",
    capabilities,
    createTranslator,
    nativeSessionId: "native-test",
    steps,
  });
  return { adapter, ctx, frames, exits, controller };
}

describe("scripted sessions", () => {
  it("emits frames in script order and records every received command with its input", async () => {
    const h = setup([
      { on: "open", frames: [frame(0)] },
      { on: "send", frames: [frame(2), frame(1)] },
      { on: "interrupt", frames: [frame(3)] },
      { on: "resolve", frames: [frame(4)] },
      { on: "stopTask", frames: [frame(5)] },
      { on: "close", frames: [frame(6)] },
    ]);
    const session = await h.adapter.openSession(h.ctx);
    expect(session.nativeSessionId).toBe("native-test");
    expect(h.frames.map(({ seq }) => seq)).toEqual([0]);
    const input: ContentPart[] = [{ type: "text", text: "hello" }];
    await session.send(input, "steer");
    input[0] = { type: "text", text: "changed later" };
    await session.interrupt({ agent: "child", cascade: true });
    await session.resolve("approval", { kind: "approval", optionId: "yes" });
    await session.stopTask("background");
    await session.close("shutdown");
    expect(h.frames.map(({ seq }) => seq)).toEqual([0, 2, 1, 3, 4, 5, 6]);
    expect(h.adapter.commands).toEqual([
      { type: "send", input: [{ type: "text", text: "hello" }], delivery: "steer" },
      { type: "interrupt", target: { agent: "child", cascade: true } },
      {
        type: "resolve",
        interaction: "approval",
        resolution: { kind: "approval", optionId: "yes" },
      },
      { type: "stopTask", task: "background" },
      { type: "close", reason: "shutdown" },
    ]);
    expect(h.adapter.sessions[0]?.commands).toEqual(h.adapter.commands);
    expect(h.exits).toEqual([{ deliberate: true }]);
    await session.close("user");
    h.controller.abort();
    expect(h.exits).toHaveLength(1);
    await expect(session.send([], "queue")).rejects.toThrow("scripted session is closed");
  });
  it("isolates resumed sessions and copies emitted frames before listeners can modify them", async () => {
    const initial = frame(0);
    const steps: ScriptedStep[] = [
      { on: "open", frames: [initial] },
      { on: "send", frames: [frame(1)] },
    ];
    const h = setup(steps);
    initial.data = "caller changed script after construction";
    const first = await h.adapter.openSession(h.ctx);
    const received = h.frames[0];
    if (!received) throw new Error("open step did not emit its frame");
    received.data = "listener modified frame";
    await first.send([], "queue");
    const second = await h.adapter.openSession({
      ...h.ctx,
      resume: { nativeSessionId: "resumed" },
    });
    expect(second.nativeSessionId).toBe("resumed");
    expect(h.frames[2]?.data).toEqual({ seq: 0 });
    await second.send([{ type: "text", text: "second" }], "queue");
    expect(h.frames.map(({ seq }) => seq)).toEqual([0, 1, 0, 1]);
    expect(h.adapter.sessions.map((session) => session.commands)).toEqual([
      [{ type: "send", input: [], delivery: "queue" }],
      [{ type: "send", input: [{ type: "text", text: "second" }], delivery: "queue" }],
    ]);
    await first.close("idle");
    await second.close("idle");
  });
  it("reports scripted process exit once and rejects commands after exit", async () => {
    const h = setup([
      { on: "send", frames: [frame(0)], exit: { deliberate: false, message: "crash" } },
    ]);
    const session = await h.adapter.openSession(h.ctx);
    await session.send([], "queue");
    expect(h.frames).toEqual([frame(0)]);
    expect(h.exits).toEqual([{ deliberate: false, message: "crash" }]);
    await expect(session.stopTask("task")).rejects.toThrow("closed");
    await session.close("user");
    h.controller.abort();
    expect(h.exits).toHaveLength(1);
  });
  it("ends the session on engine abort and refuses an already aborted lifetime", async () => {
    const h = setup([{ on: "open", frames: [frame(0)] }]);
    const session = await h.adapter.openSession(h.ctx);
    h.controller.abort();
    expect(h.exits).toEqual([{ deliberate: true, message: "aborted" }]);
    await expect(session.interrupt({ cascade: false })).rejects.toThrow("closed");
    await expect(h.adapter.openSession(h.ctx)).rejects.toThrow();
    expect(h.frames).toEqual([frame(0)]);
  });
  it("rejects an out-of-order command without consuming the pending script step", async () => {
    const h = setup([{ on: "resolve", frames: [frame(1)] }]);
    const session = await h.adapter.openSession(h.ctx);
    await expect(session.send([], "queue")).rejects.toThrow(
      "script step 0 expected resolve, got send",
    );
    expect(h.frames).toEqual([]);
    await session.resolve("q", { kind: "question", answers: {} });
    expect(h.frames).toEqual([frame(1)]);
    expect(h.adapter.commands.map(({ type }) => type)).toEqual(["send", "resolve"]);
    await session.close("idle");
  });
  it("tears down shutdown with a pending send while preserving the script mismatch", async () => {
    const h = setup([{ on: "send", frames: [frame(0)] }]);
    const session = await h.adapter.openSession(h.ctx);
    await expect(session.close("shutdown")).rejects.toThrow("expected send, got close");
    expect(h.exits).toEqual([{ deliberate: true }]);
    expect(getEventListeners(h.ctx.signal, "abort")).toEqual([]);
    await expect(session.send([], "queue")).rejects.toThrow("closed");
    h.controller.abort();
    expect(h.frames).toEqual([]);
    expect(h.exits).toHaveLength(1);
  });
  it("removes the abort listener even when the closing frame callback throws", async () => {
    const h = setup([{ on: "close", frames: [frame(0)] }]);
    const session = await h.adapter.openSession({
      ...h.ctx,
      onFrame() {
        throw new Error("close callback failed");
      },
    });
    await expect(session.close("shutdown")).rejects.toThrow("close callback failed");
    expect(h.exits).toEqual([{ deliberate: true }]);
    expect(getEventListeners(h.ctx.signal, "abort")).toEqual([]);
    await expect(session.send([], "queue")).rejects.toThrow("closed");
  });
  it.each([0, 1])(
    "rolls back an open rejected by frame %i without retaining a lifetime",
    async (throwAt) => {
      const h = setup([{ on: "open", frames: [frame(0), frame(1)] }]);
      await expect(
        h.adapter.openSession({
          ...h.ctx,
          onFrame(value) {
            h.frames.push(value);
            if (value.seq === throwAt) throw new Error("opening callback failed");
          },
        }),
      ).rejects.toThrow("opening callback failed");
      expect(h.adapter.sessions).toEqual([]);
      expect(getEventListeners(h.ctx.signal, "abort")).toEqual([]);
      h.controller.abort();
      expect(h.exits).toEqual([]);
      expect(h.frames.map(({ seq }) => seq)).toEqual(throwAt === 0 ? [0] : [0, 1]);
      const retry = await h.adapter.openSession({ ...h.ctx, signal: new AbortController().signal });
      expect(h.frames.slice(-2)).toEqual([frame(0), frame(1)]);
      expect(h.adapter.sessions).toEqual([retry]);
      await retry.close("shutdown");
    },
  );
  it.each(["open", "send"] as const)(
    "stops %s frames immediately after a callback abort",
    async (on) => {
      const h = setup([{ on, frames: [frame(0), frame(1)] }]);
      const session = await h.adapter.openSession({
        ...h.ctx,
        onFrame(value) {
          h.frames.push(value);
          if (value.seq === 0) h.controller.abort();
        },
      });
      if (on === "send") await session.send([], "queue");
      expect(h.frames).toEqual([frame(0)]);
      expect(h.exits).toEqual([{ deliberate: true, message: "aborted" }]);
      expect(getEventListeners(h.ctx.signal, "abort")).toEqual([]);
      await expect(session.send([], "queue")).rejects.toThrow("closed");
    },
  );
  it("finishes send frames before a reentrant interrupt emits its frames", async () => {
    const h = setup([
      { on: "send", frames: [frame(0), frame(1)] },
      { on: "interrupt", frames: [frame(2)] },
    ]);
    let nested: Promise<void> | undefined;
    const session = await h.adapter.openSession({
      ...h.ctx,
      onFrame(value) {
        h.frames.push(value);
        if (value.seq === 0) nested = session.interrupt({ cascade: true });
      },
    });
    await session.send([], "queue");
    if (!nested) throw new Error("send did not trigger the nested interrupt");
    await nested;
    expect(h.frames.map(({ seq }) => seq)).toEqual([0, 1, 2]);
    expect(h.adapter.commands.map(({ type }) => type)).toEqual(["send", "interrupt"]);
    await session.close("shutdown");
  });
  it("finishes shutdown before a command queued by the same frame callback can emit", async () => {
    const h = setup([
      { on: "send", frames: [frame(0), frame(1)] },
      { on: "close", frames: [frame(2)] },
      { on: "send", frames: [frame(3)] },
    ]);
    let closing: Promise<void> | undefined;
    let later: Promise<unknown> | undefined;
    const session = await h.adapter.openSession({
      ...h.ctx,
      onFrame(value) {
        h.frames.push(value);
        if (value.seq === 0) {
          closing = session.close("shutdown");
          later = session.send([], "queue").catch((error: unknown) => error);
        }
      },
    });
    await session.send([], "queue");
    if (!closing || !later) throw new Error("send did not queue shutdown and later command");
    await closing;
    expect(await later).toEqual(expect.objectContaining({ message: "scripted session is closed" }));
    expect(h.frames.map(({ seq }) => seq)).toEqual([0, 1, 2]);
    expect(h.exits).toEqual([{ deliberate: true }]);
    expect(getEventListeners(h.ctx.signal, "abort")).toEqual([]);
  });
});
