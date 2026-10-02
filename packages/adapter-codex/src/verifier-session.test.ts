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
