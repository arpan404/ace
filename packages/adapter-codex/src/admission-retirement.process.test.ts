import { expect, test } from "vitest";
import { sessionHarness } from "./session.test-helper.ts";
import { obj } from "./native.ts";

const note = (event: string) => (f: { dir: string; data: unknown }) =>
  f.dir === "note" && obj(f.data)["event"] === event;

test("an execution frame over the payload bound is left out and its turn still settles", async () => {
  const h = await sessionHarness();
  try {
    // A pending approval, then its command's 1.1 MB completion, then the turn's end.
    await h.session.send([{ type: "text", text: "oversized-execution" }], "steer");
    const omitted = await h.wait(note("output-line-dropped"));
    expect(obj(omitted.data)["reason"]).toBe("frame-bound");
    // The first read races the turn's end; the scheduled retry reads it settled.
    await h.wait(note("thread-discovered"));
    // Let that read finish releasing before its retry fires.
    await new Promise((resolve) => setImmediate(resolve));
    h.runTimers();
    await h.wait(
      (f) => note("discovery-finished")(f) && obj(f.data)["task"] === "codex:output-recovery",
    );
    expect(h.exits).toEqual([]);
    expect(h.replay.state.status.state).toBe("done");
    // The turn ended with the approval unanswered; it can no longer be answered.
    expect(Object.values(h.replay.state.interactions)).toEqual([
      expect.objectContaining({ state: "cancelled" }),
    ]);
    await expect(
      h.session.resolve(h.requestKey(100), { kind: "approval", optionId: "accept" }),
    ).rejects.toMatchObject({ code: "interaction_unavailable" });
    // The session keeps taking work.
    const barrier = h.frames.at(-1)?.seq ?? 0;
    await h.session.send([{ type: "text", text: "after" }], "steer");
    await h.wait((f) => f.seq > barrier && obj(f.data)["method"] === "turn/started");
  } finally {
    await h.dispose();
  }
});

test("an oversized question retires the provider and preserves unfinished work as failure", async () => {
  const h = await sessionHarness();
  try {
    // An answerable approval, then a second one too large to admit.
    await h.session.send([{ type: "text", text: "oversized-approval" }], "steer");
    const exit = await Promise.race([
      h.exited,
      new Promise<undefined>((resolve) => setTimeout(resolve, 500, undefined)),
    ]);
    expect(exit?.deliberate).toBe(false);
    expect(h.exits).toHaveLength(1);
    expect(h.replay.state.status.state).toBe("failed");
    expect(Object.values(h.replay.state.interactions)).toEqual([
      expect.objectContaining({ state: "expired" }),
    ]);
    await expect(
      h.session.resolve(h.requestKey(100), { kind: "approval", optionId: "accept" }),
    ).rejects.toMatchObject({ code: "interaction_unavailable" });
    await expect(h.session.interrupt({ cascade: false })).rejects.toThrow("session is closed");
    await h.session.close("shutdown");
    expect(h.exits).toHaveLength(1);
  } finally {
    await h.dispose();
  }
});
