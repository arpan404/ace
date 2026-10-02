import { describe, expect, it } from "vitest";
import { Agent, BackgroundTask, Command, Event, InteractionResolution } from "./index.ts";

const agent = {
  id: "agt_child",
  threadId: "thr_1",
  parentId: "agt_root",
  origin: "provider_subagent",
  native: { provider: "opencode", nativeId: "ses_child" },
  fidelity: "full",
  spawnedBy: "itm_task",
  cwd: "/repo",
  status: { state: "blocked", on: "background_task", refs: ["bgt_1"] },
  createdAt: 1,
};

describe("protocol schemas", () => {
  it("parses a subagent with a parent link and a blocked status", () => {
    const parsed = Agent.parse(agent);
    expect(parsed.parentId).toBe("agt_root");
    expect(parsed.background).toBe(false);
  });

  it("rejects an unknown blocked reason", () => {
    const bad = { ...agent, status: { state: "blocked", on: "coffee" } };
    expect(Agent.safeParse(bad).success).toBe(false);
  });

  it("parses an event envelope and narrows on payload type", () => {
    const event = Event.parse({
      seq: 42,
      id: "evt_42",
      at: 1000,
      threadId: "thr_1",
      payload: {
        type: "interaction.closed",
        interactionId: "int_1",
        state: "expired",
        closedAt: 1000,
      },
    });
    expect(event.payload.type).toBe("interaction.closed");
    if (event.payload.type === "interaction.closed") expect(event.payload.state).toBe("expired");
  });

  it("does not allow closing an interaction as pending", () => {
    const result = Event.safeParse({
      seq: 1,
      id: "evt_1",
      at: 1,
      threadId: "thr_1",
      payload: {
        type: "interaction.closed",
        interactionId: "int_1",
        state: "pending",
        closedAt: 1,
      },
    });
    expect(result.success).toBe(false);
  });

  it("defaults interrupts to cascading", () => {
    const command = Command.parse({
      id: "cmd_1",
      deviceId: "dev_phone",
      payload: { type: "thread.interrupt", threadId: "thr_1" },
    });
    expect(command.payload.type === "thread.interrupt" && command.payload.cascade).toBe(true);
  });

  it("defaults background tasks to non-ambient and keeps unknown status", () => {
    const task = BackgroundTask.parse({
      id: "bgt_1",
      agentId: "agt_root",
      kind: "shell",
      title: "for i in …",
      status: "unknown",
      stoppable: false,
      startedAt: 1,
    });
    expect(task.ambient).toBe(false);
    expect(task.status).toBe("unknown");
  });

  it("accepts a dismissed question and a cancelled plan review", () => {
    expect(
      InteractionResolution.parse({ kind: "question", answers: {}, dismissed: true }),
    ).toMatchObject({ dismissed: true });
    expect(InteractionResolution.parse({ kind: "plan_review", decision: "cancel" })).toMatchObject({
      decision: "cancel",
    });
  });
});
