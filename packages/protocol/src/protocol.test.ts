import { describe, expect, it } from "vitest";
import {
  Agent,
  BackgroundTask,
  Command,
  Event,
  LiveActivitySync,
  NotificationRegister,
} from "./index.ts";

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
});

describe("live activity sync", () => {
  const liveActivity = {
    startToken: "a1".repeat(32),
    activityToken: "b2".repeat(32),
    environment: "sandbox",
    frequentUpdates: true,
    slot: 3,
  };

  it("registers a phone's live activity tokens beside its push address", () => {
    const parsed = NotificationRegister.parse({
      type: "notification.register",
      device: { channel: "websocket", platform: "phone" },
      liveActivity,
    });
    expect(parsed.liveActivity).toEqual(liveActivity);
  });

  it("keeps a registration without live activity tokens", () => {
    const parsed = NotificationRegister.parse({
      type: "notification.register",
      device: { channel: "websocket", platform: "phone" },
    });
    expect(parsed.liveActivity).toBeUndefined();
  });

  it("allows either token alone and the ends of the slot range", () => {
    expect(
      LiveActivitySync.safeParse({ ...liveActivity, activityToken: undefined, slot: 0 }).success,
    ).toBe(true);
    expect(
      LiveActivitySync.safeParse({ ...liveActivity, startToken: undefined, slot: 15 }).success,
    ).toBe(true);
  });

  it("refuses a slot outside the phone's sixteen machines", () => {
    for (const slot of [-1, 16, 2.5]) {
      expect(LiveActivitySync.safeParse({ ...liveActivity, slot }).success).toBe(false);
    }
  });

  it("refuses a token outside APNs' length or alphabet", () => {
    for (const startToken of ["a".repeat(15), "a".repeat(401), "not-hex"]) {
      expect(LiveActivitySync.safeParse({ ...liveActivity, startToken }).success).toBe(false);
    }
    expect(LiveActivitySync.safeParse({ ...liveActivity, activityToken: null }).success).toBe(
      false,
    );
  });

  it("requires the APNs environment and whether frequent updates are on", () => {
    const { environment: _environment, ...withoutEnvironment } = liveActivity;
    const { frequentUpdates: _frequentUpdates, ...withoutFrequentUpdates } = liveActivity;
    expect(LiveActivitySync.safeParse(withoutEnvironment).success).toBe(false);
    expect(LiveActivitySync.safeParse(withoutFrequentUpdates).success).toBe(false);
    expect(
      LiveActivitySync.safeParse({ ...liveActivity, environment: "development" }).success,
    ).toBe(false);
  });
});
