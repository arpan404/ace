import { expect, test } from "vitest";
import { sessionHarness } from "./session.test-helper.ts";
import { obj } from "./native.ts";
const text = (value: string) => [{ type: "text" as const, text: value }];
const note = (event: string) => (f: { dir: string; data: unknown }) =>
  f.dir === "note" && obj(f.data)["event"] === event;
const received = (method: string) => (f: { dir: string; data: unknown }) =>
  f.dir === "recv" && obj(f.data)["method"] === method;
test("answering one of two async questions leaves the other pending", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(text("two-questions"), "steer");
    await h.wait(
      (f) =>
        received("item/completed")(f) && obj(obj(obj(f.data)["params"])["item"])["id"] === "q2",
    );
    await h.session.resolve("async:q", { kind: "question", answers: { q0: ["Tabs"] } });
    expect(h.replay.state.interactions["async:q"]?.state).toBe("resolved");
    expect(h.replay.state.interactions["async:q2"]?.state).toBe("pending");
  } finally {
    await h.dispose();
  }
});
test("completion in the start response chunk leaves the next send starting a fresh turn", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(text("same-chunk"), "steer");
    await h.session.send(text("running"), "steer");
    expect(
      h.frames.filter((f) => f.dir === "send" && obj(f.data)["method"] === "turn/start"),
    ).toHaveLength(2);
  } finally {
    await h.dispose();
  }
});
test("resumed active turns steer input and can be interrupted", async () => {
  const h = await sessionHarness(true, "active");
  try {
    await h.session.send(text("correction"), "steer");
    expect(h.frames.some((f) => f.dir === "send" && obj(f.data)["method"] === "turn/steer")).toBe(
      true,
    );
    await h.session.interrupt({ cascade: false });
    await h.wait(received("turn/completed"));
    expect(
      Object.values(h.replay.state.runs).some(
        (r) => r.nativeId === "resumed" && r.state === "interrupted",
      ),
    ).toBe(true);
  } finally {
    await h.dispose();
  }
});
test("loaded reconciliation excludes unrelated active threads", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(text("unrelated"), "steer");
    await h.wait(note("discovery-finished"));
    expect(h.replay.state.status.state).toBe("done");
    expect(
      Object.values(h.replay.state.agents).some((a) => a.agent.native.nativeId === "unrelated"),
    ).toBe(false);
  } finally {
    await h.dispose();
  }
});
test("failed loaded discovery retains the guard until a successful retry", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(text("failed-discovery"), "steer");
    await h.wait((f) => f.dir === "stderr");
    expect(h.replay.state.status.state).not.toBe("done");
    expect(h.frames.some(note("discovery-finished"))).toBe(false);
    h.runTimers();
    await h.wait(note("discovery-finished"));
    expect(h.replay.state.status.state).toBe("working");
    expect(
      h.replay.events.some((e) => e.type === "thread.updated" && e.status?.state === "done"),
    ).toBe(false);
  } finally {
    await h.dispose();
  }
});
test("delta-only background shells can be stopped by their public task key", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(text("delta-shell"), "steer");
    await h.wait(note("discovery-finished"));
    expect(h.replay.state.status.state).toBe("waiting");
    await h.session.stopTask("shell:delta-exec");
    await h.session.send(text("running"), "steer"); // response is a barrier after termination notifications
    expect(Object.values(h.replay.state.tasks).every((t) => t.status === "completed")).toBe(true);
  } finally {
    await h.dispose();
  }
});
test("native queue counts stay visible after enqueue", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(text("running"), "steer");
    await h.wait(received("turn/started"));
    await h.session.send(text("queued"), "queue");
    await h.session.interrupt({ cascade: false });
    await h.wait(note("discovery-finished"));
    expect(h.replay.state.status).toEqual({ state: "waiting", on: "queue" });
  } finally {
    await h.dispose();
  }
});

test("resumed shell history is rendered and remains stoppable after its turn ended", async () => {
  const h = await sessionHarness(true, "shell");
  try {
    expect(h.replay.state.status).toEqual({ state: "waiting", on: "background_task" });
    expect(
      Object.values(h.replay.state.items).some(
        (i) =>
          i.type === "message" &&
          i.parts.some((p) => p.type === "text" && p.text === "historical message"),
      ),
    ).toBe(true);
    await h.session.stopTask("shell:hydrated");
    await h.session.send(text("running"), "steer");
    expect(
      Object.values(h.replay.state.tasks)
        .filter((t) => t.kind === "shell")
        .every((t) => t.status === "completed"),
    ).toBe(true);
  } finally {
    await h.dispose();
  }
});
