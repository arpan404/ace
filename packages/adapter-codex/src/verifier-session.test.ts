import { expect, test } from "vitest";
import { sessionHarness } from "./session.test-helper.ts";
import { obj } from "./native.ts";
const text = (value: string) => [{ type: "text" as const, text: value }];
const note = (event: string) => (f: { dir: string; data: unknown }) =>
  f.dir === "note" && obj(f.data)["event"] === event;
test("a resume snapshot cannot resurrect a turn completed in the reply chunk", async () => {
  const h = await sessionHarness(true, "resume-completed");
  try {
    await h.session.send(text("running"), "steer");
    expect(
      h.frames.filter((f) => f.dir === "send" && obj(f.data)["method"] === "turn/start"),
    ).toHaveLength(1);
  } finally {
    await h.dispose();
  }
});
test("truncated child recovery retries a failed read even after ancestry becomes known", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(text("overflow-read"), "steer");
    await h.wait(note("discovery-finished"));
    expect(h.replay.state.status.state).not.toBe("done");
    h.runTimers();
    await h.wait((f) => f.dir === "stderr");
    expect(h.replay.state.status.state).not.toBe("done");
    const beforeRetry = h.frames.at(-1)?.seq ?? 0;
    h.runTimers();
    // A subsequent offline provider command/list response is an I/O barrier, even if no retry ran.
    await h.session.send(text("finish"), "steer");
    await h.wait((f) => f.seq > beforeRetry && note("discovery-finished")(f));
    expect(h.replay.state.status.state).toBe("done");
  } finally {
    await h.dispose();
  }
});
test("a read without turn history keeps recovery pending and retries the complete transcript", async () => {
  const h = await sessionHarness(false, "omitted-history");
  try {
    await h.session.send(text("overflow-read"), "steer");
    await h.wait(note("discovery-finished"));
    h.runTimers();
    const firstBarrier = h.frames.at(-1)?.seq ?? 0;
    // A provider round trip completes even if the malformed read was incorrectly accepted.
    await h.session.send(text("finish"), "steer");
    await h.wait((f) => f.seq > firstBarrier && note("discovery-finished")(f));
    expect(
      h.frames.some((f) => f.dir === "stderr" && String(f.data).includes("omitted turn history")),
    ).toBe(true);
    expect(h.replay.state.status.state).not.toBe("done");
    const retryBarrier = h.frames.at(-1)?.seq ?? 0;
    h.runTimers();
    await h.session.send(text("finish"), "steer");
    await h.wait((f) => f.seq > retryBarrier && note("discovery-finished")(f));
    expect(
      Object.values(h.replay.state.items).some(
        (i) =>
          i.type === "message" && i.parts.some((p) => p.type === "text" && p.text === "recovered"),
      ),
    ).toBe(true);
    expect(h.replay.state.status.state).toBe("done");
  } finally {
    await h.dispose();
  }
});
test("close terminates a provider that ignores graceful shutdown and reports one exit", async () => {
  const h = await sessionHarness(false, "ignore-term");
  try {
    await h.session.close("shutdown");
    expect((await h.exited).deliberate).toBe(true);
    expect(h.exits).toHaveLength(1);
    await expect(h.session.send(text("after"), "steer")).rejects.toThrow("closed");
  } finally {
    await h.dispose();
  }
});

test("a read snapshot cannot resurrect a child completed in the reply chunk", async () => {
  const h = await sessionHarness(false, "read-completed");
  try {
    await h.session.send(text("hidden-child"), "steer");
    await h.wait(
      (f) => note("thread-discovered")(f) && obj(obj(f.data)["thread"])["id"] === "hidden",
    );
    await h.session.interrupt({ agent: "hidden", cascade: false });
    await h.wait(note("discovery-finished"));
    expect(h.replay.state.status.state).toBe("done");
  } finally {
    await h.dispose();
  }
});

test("a fully evicted child recovers completed history despite saturated unknown timers", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(text("evicted-child"), "steer");
    await h.wait(note("discovery-finished"));
    const messages = Object.values(h.replay.state.items).flatMap((i) =>
      i.type === "message" ? i.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])) : [],
    );
    expect(messages).toContain("recovered completed history");
    expect(h.replay.state.status.state).toBe("done");
    h.runTimers();
    // The next provider round trip is a barrier for every scheduled recovery request.
    const barrier = h.frames.at(-1)?.seq ?? 0;
    await h.session.send(text("finish"), "steer");
    await h.wait((f) => f.seq > barrier && note("discovery-finished")(f));
    expect(h.replay.state.status.state).toBe("done");
  } finally {
    await h.dispose();
  }
});
test("an acknowledged turn steers input before its start notification arrives", async () => {
  const h = await sessionHarness(false, "reply-before-start");
  try {
    await h.session.send(text("running"), "steer");
    await h.session.send(text("correction"), "steer");
    await h.wait((f) => JSON.stringify(f.data).includes("steered: correction"));
    const messages = Object.values(h.replay.state.items).flatMap((i) =>
      i.type === "message" ? i.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])) : [],
    );
    expect(messages).toContain("steered: correction");
  } finally {
    await h.dispose();
  }
});

test("admission schedules evicted child recovery despite saturated timers before root completion", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(text("evicted-child-live"), "steer");
    await h.wait((f) => JSON.stringify(f.data).includes("spawn-lost"));
    h.runTimers();
    await h.session.send(text("barrier"), "steer");
    await h.wait((f) => JSON.stringify(f.data).includes("steered: barrier"));
    expect(
      Object.values(h.replay.state.items).some(
        (i) =>
          i.type === "message" &&
          i.parts.some((p) => p.type === "text" && p.text === "recovered completed history"),
      ),
    ).toBe(true);
    expect(h.replay.state.status.state).toBe("working");
    await h.session.interrupt({ agent: "root", cascade: false });
    await h.wait(note("discovery-finished"));
    expect(h.replay.state.status.state).toBe("done");
  } finally {
    await h.dispose();
  }
});
