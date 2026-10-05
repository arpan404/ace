import { expect, test } from "vitest";
import { sessionHarness } from "./session.test-helper.ts";
import { asyncKey, obj, planKey, shellKey, str } from "./native.ts";
const received = (method: string) => (frame: { dir: string; data: unknown }) =>
  frame.dir === "recv" && obj(frame.data)["method"] === method;
const proof = (id: string) => (frame: { dir: string; data: unknown }) =>
  received("item/completed")(frame) && obj(obj(obj(frame.data)["params"])["item"])["id"] === id;
const text = (value: string) => [{ type: "text" as const, text: value }];

test("session starts the discovered CLI with experimental API and resumes native threads", async () => {
  const h = await sessionHarness(true);
  try {
    expect(h.session.nativeSessionId).toBe("native");
    expect(
      h.frames.some((f) => f.dir === "send" && obj(f.data)["method"] === "thread/resume"),
    ).toBe(true);
    await h.session.send(text("running"), "queue");
    await h.wait(received("turn/started"));
    expect(h.replay.state.status.state).toBe("working");
  } finally {
    await h.dispose();
  }
});
test("steering injects input in the active turn while queue delivery preserves it for later", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(text("running"), "queue");
    await h.wait(received("turn/started"));
    await h.session.send(text("followup"), "queue");
    const queued = await h.wait(proof("queue-proof"));
    expect(str(obj(obj(obj(queued.data)["params"])["item"])["text"])).toBe("queued: followup");
    await h.session.send(text("correction"), "steer");
    const steered = await h.wait(proof("proof"));
    expect(str(obj(obj(obj(steered.data)["params"])["item"])["text"])).toBe("steered: correction");
  } finally {
    await h.dispose();
  }
});
test("async answers use steering and resolve without blocking a running model", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(text("question"), "queue");
    await h.wait(proof("q"));
    expect(h.replay.state.status.state).toBe("working");
    await h.session.resolve(asyncKey("q"), { kind: "question", answers: { q0: ["Tabs"] } });
    const reply = await h.wait(proof("proof"));
    expect(str(obj(obj(obj(reply.data)["params"])["item"])["text"])).toBe("steered: Tabs");
    await h.wait((f) => f.dir === "note" && obj(f.data)["event"] === "discovery-finished");
    expect(h.replay.state.status.state).toBe("done");
  } finally {
    await h.dispose();
  }
});
test("approval amendments retain the exact offered provider decision", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(text("approval"), "queue");
    await h.wait(received("item/commandExecution/requestApproval"));
    await expect(
      h.session.resolve(h.requestKey(100), { kind: "approval", optionId: "decline" }),
    ).rejects.toThrow("not offered");
    await h.session.resolve(h.requestKey(100), {
      kind: "approval",
      optionId: "acceptWithExecpolicyAmendment",
    });
    const reply = await h.wait(proof("response-proof"));
    expect(JSON.parse(str(obj(obj(obj(reply.data)["params"])["item"])["text"]))).toEqual({
      decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["echo"] } },
    });
  } finally {
    await h.dispose();
  }
});
test("questions without a backing item receive the provider answer envelope", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(text("input"), "queue");
    await h.wait(received("item/tool/requestUserInput"));
    await h.session.resolve(h.requestKey(100), { kind: "question", answers: { q: ["Yes"] } });
    const reply = await h.wait(proof("response-proof"));
    expect(JSON.parse(str(obj(obj(obj(reply.data)["params"])["item"])["text"]))).toEqual({
      answers: { q: { answers: ["Yes"] } },
    });
  } finally {
    await h.dispose();
  }
});
test.each(["approve", "reject"] as const)(
  "plan %s starts a turn with the matching collaboration mode",
  async (decision) => {
    const h = await sessionHarness();
    try {
      await h.session.send(text("plan"), "queue");
      await h.wait(received("turn/completed"));
      expect(h.replay.state.status.state).toBe("needs_you");
      await h.session.resolve(planKey("turn"), {
        kind: "plan_review",
        decision,
        feedback: "Revise the plan.",
      });
      const reply = await h.wait(proof("plan-proof"));
      const result = JSON.parse(str(obj(obj(obj(reply.data)["params"])["item"])["text"]));
      expect(result.collaborationMode.mode).toBe(decision === "approve" ? "default" : "plan");
      expect(result.input[0].text).toBe(
        decision === "approve" ? "Implement the plan." : "Revise the plan.",
      );
    } finally {
      await h.dispose();
    }
  },
);
test("cascade interrupts children and terminates surviving terminals by listed process id", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(text("tree"), "queue");
    await h.wait(received("item/started"));
    await h.session.interrupt({ cascade: true });
    expect(Object.values(h.replay.state.runs).every((r) => r.state === "interrupted")).toBe(true);
    await h.session.send(text("terminal-proof"), "steer");
    const terminals = await h.wait(proof("terminal-proof"));
    expect(JSON.parse(str(obj(obj(obj(terminals.data)["params"])["item"])["text"]))).toEqual([]);
    expect(
      Object.values(h.replay.state.tasks)
        .filter((t) => t.kind === "shell")
        .every((t) => t.status === "completed"),
    ).toBe(true);
  } finally {
    await h.dispose();
  }
});
test("stopping one terminal leaves other agents and terminals working", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(text("tree"), "queue");
    await h.wait(received("item/started"));
    await h.session.stopTask(shellKey("root-exec"));
    await h.wait(proof("root-exec"));
    expect(h.replay.state.status.state).toBe("working");
    expect(Object.values(h.replay.state.runs).filter((r) => r.state === "active")).toHaveLength(2);
  } finally {
    await h.dispose();
  }
});
test("loaded descendant reconciliation prevents done before an unseen child is hydrated", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(text("hidden-child"), "queue");
    await h.wait((f) => f.dir === "note" && obj(f.data)["event"] === "discovery-finished");
    expect(h.replay.state.status.state).toBe("working");
    expect(
      Object.values(h.replay.state.agents).some(
        (a) => a.agent.native.nativeId === "hidden" && a.agent.status.state === "working",
      ),
    ).toBe(true);
    expect(
      h.replay.events
        .filter((e) => e.type === "thread.updated")
        .some((e) => e.type === "thread.updated" && e.status?.state === "done"),
    ).toBe(false);
  } finally {
    await h.dispose();
  }
});
test("abort closes the owned process once and rejects subsequent work", async () => {
  const h = await sessionHarness();
  try {
    h.controller.abort();
    expect((await h.exited).deliberate).toBe(true);
    await expect(h.session.send(text("after"), "queue")).rejects.toThrow("closed");
    await h.session.close("user");
    expect(h.exits).toHaveLength(1);
  } finally {
    await h.dispose();
  }
});
test("unexpected process exit reports failure and releases active work", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(text("exit"), "queue");
    const exit = await h.exited;
    expect(exit.deliberate).toBe(false);
    expect(h.replay.state.status.state).toBe("failed");
  } finally {
    await h.dispose();
  }
});

test("non-cascading interruption leaves child turns and background terminals live", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(text("tree"), "queue");
    await h.wait(received("item/started"));
    await h.session.interrupt({ cascade: false });
    await h.wait(received("turn/completed"));
    expect(h.replay.state.status.state).not.toBe("done");
    expect(Object.values(h.replay.state.runs).filter((r) => r.state === "active")).toHaveLength(1);
    expect(Object.values(h.replay.state.tasks).some((t) => t.status === "running")).toBe(true);
  } finally {
    await h.dispose();
  }
});

test("an unknown thread without a spawn item is adopted from thread-read metadata", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(text("orphan"), "queue");
    await h.wait(proof("orphan-text"));
    h.runTimers();
    await h.wait(
      (f) =>
        f.dir === "note" &&
        obj(f.data)["event"] === "thread-discovered" &&
        obj(obj(f.data)["thread"])["id"] === "orphan",
    );
    const orphan = Object.values(h.replay.state.agents).find(
      (a) => a.agent.native.nativeId === "orphan",
    );
    expect(orphan?.agent.fidelity).toBe("full");
    expect(orphan?.agent.status.state).toBe("working");
    expect(
      Object.values(h.replay.state.items).some(
        (i) =>
          i.type === "message" &&
          i.parts.some((p) => p.type === "text" && p.text === "early transcript"),
      ),
    ).toBe(true);
  } finally {
    await h.dispose();
  }
});

test("a repeated native terminal cursor rejects cascade visibly instead of hanging Stop", async () => {
  const h = await sessionHarness(false, "terminal-loop");
  try {
    await expect(h.session.interrupt({ cascade: true })).rejects.toThrow("completely interrupt");
    // Listing failure is observable; it must never report that terminals were all stopped.
    expect(
      h.frames.some(
        (f) => f.dir === "send" && obj(f.data)["method"] === "thread/backgroundTerminals/terminate",
      ),
    ).toBe(false);
  } finally {
    await h.dispose();
  }
});
