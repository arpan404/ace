import { expect, test } from "vitest";
import { replayFixture } from "@ace/adapter-testkit";
import type { Frame } from "@ace/engine-api";
import { antigravityQuirks, createAcpTranslator, genericQuirks, type AcpQuirks } from "./index.ts";

function replayChild(quirks: AcpQuirks, states: readonly string[]) {
  const childFrames = states.map((state) => ({
    method: "session/update",
    params: {
      sessionId: "parent",
      update: {
        sessionUpdate: "subagent_state_update",
        subagentSessionId: "child",
        state,
        futureChildMetadata: { retained: state },
      },
    },
  }));
  const inputs: Pick<Frame, "data" | "dir">[] = [
    { dir: "send", data: { id: 1, method: "session/new", params: { cwd: "/fixture" } } },
    { dir: "recv", data: { id: 1, result: { sessionId: "parent" } } },
    {
      dir: "send",
      data: {
        id: 2,
        method: "session/prompt",
        params: { sessionId: "parent", prompt: [{ type: "text", text: "Parent input" }] },
      },
    },
    { dir: "recv", data: childFrames[0] },
    { dir: "recv", data: { id: 2, result: { stopReason: "end_turn" } } },
    ...childFrames.slice(1).map((data) => ({ dir: "recv" as const, data })),
  ];
  const frames = inputs.map((input, index) =>
    Object.assign({}, input, { seq: index, t: index, channel: "stdio" }),
  );
  return {
    childFrames,
    result: replayFixture({
      createTranslator: (init) =>
        createAcpTranslator(
          { ...init, identity: { generation: "child-diagnostics", cursor: 0 } },
          quirks,
        ),
      coreConfig: { provider: quirks.provider, silenceMs: 90000 },
      fixture: {
        header: {
          format: "ace-recording/v1",
          provider: quirks.provider,
          cliVersion: "synthetic",
          scenario: "child association diagnostics",
          startedAt: "2026-10-05",
          platform: "test",
          workspace: "/fixture",
        },
        frames,
      },
    }),
  };
}

for (const quirks of [genericQuirks, antigravityQuirks]) {
  // Mutation: restore explicit association text or drop child facts/raw.
  // Not executed (tests run at merge).
  test(`${quirks.provider} repeated child snapshots retain association and completion without transcript notices`, () => {
    const { childFrames, result } = replayChild(quirks, [
      "running",
      "running",
      "running",
      "completed",
      "completed",
    ]);
    expect(result.timeline.find((entry) => entry.t === 4)?.thread.state).toBe("working");
    expect(result.final.thread.state).toBe("done");
    const child = Object.values(result.final.view.agents).find(
      (agent) => agent.native.nativeId === "child",
    );
    const parent = Object.values(result.final.view.agents).find(
      (agent) => agent.native.nativeId === "parent",
    );
    expect(child?.status.state).toBe("idle");
    expect(child?.parentId).toBe(parent?.id);
    expect(result.final.agents).toBe(2);
    expect(Object.values(result.final.view.items).filter((item) => item.type === "notice")).toEqual(
      [],
    );
    for (const frame of childFrames)
      expect(result.diagnostics).toContainEqual({ type: "subagent_state_update", data: frame });
  });

  // Mutation: suppress the disconnected warning or settle a disconnected child.
  // Not executed (tests run at merge).
  test(`${quirks.provider} a disconnected child keeps its readable warning and completion uncertain`, () => {
    const { childFrames, result } = replayChild(quirks, ["running", "disconnected"]);
    expect(result.final.thread.state).not.toBe("done");
    const notices = Object.values(result.final.view.items).filter((item) => item.type === "notice");
    expect(notices).toMatchObject([{ text: "Child disconnected; completion is unconfirmed" }]);
    expect(result.diagnostics).toContainEqual({
      type: "subagent_state_update",
      data: childFrames[1],
    });
  });
}
