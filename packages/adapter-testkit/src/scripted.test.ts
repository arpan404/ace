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
});
