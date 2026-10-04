import { expect, test } from "vitest";
import { sessionHarness } from "./session.test-helper.ts";
import { obj, requestKey } from "./native.ts";

test("reopening reconstructs answered questions and plans without new answer actions", async () => {
  const h = await sessionHarness(true, "historical-interactions");
  try {
    expect(Object.values(h.replay.state.interactions)).toEqual([]);
    expect(h.replay.state.items["answered-a"]).toMatchObject({ type: "tool_call", complete: true });
    expect(h.replay.state.items["answered-b"]).toMatchObject({ type: "tool_call", complete: true });
    for (const key of ["async:answered-a", "async:answered-b", "plan:old"]) {
      await expect(
        h.session.resolve(key, { kind: "question", answers: { q0: ["yes"] } }),
      ).rejects.toMatchObject({ code: "interaction_unavailable" });
    }
    expect(
      h.frames.some(
        (f) =>
          f.dir === "send" && ["turn/start", "turn/steer"].includes(String(obj(f.data).method)),
      ),
    ).toBe(false);
    await h.session.send([{ type: "text", text: "replay-answered" }], "steer");
    await h.wait((f) => obj(f.data).method === "turn/completed");
    expect(Object.values(h.replay.state.interactions)).toEqual([]);
  } finally {
    await h.dispose();
  }
});

test("a fresh request after resume has a process-owned answer handle and resolves exactly once", async () => {
  const h = await sessionHarness(true, "historical-interactions");
  try {
    await h.session.send([{ type: "text", text: "approval" }], "steer");
    await h.wait((f) => obj(f.data).method === "item/commandExecution/requestApproval");
    await expect(
      h.session.resolve(requestKey(100, "previous-process"), {
        kind: "approval",
        optionId: "accept",
      }),
    ).rejects.toMatchObject({ code: "interaction_unavailable" });
    expect(
      Object.values(h.replay.state.interactions).filter((i) => i.state === "pending"),
    ).toHaveLength(1);
    await h.session.resolve(h.requestKey(100), { kind: "approval", optionId: "accept" });
    await h.wait((f) => obj(f.data).method === "serverRequest/resolved");
    expect(
      Object.values(h.replay.state.interactions).filter((i) => i.state === "resolved"),
    ).toHaveLength(1);
    await expect(
      h.session.resolve(h.requestKey(100), { kind: "approval", optionId: "accept" }),
    ).rejects.toMatchObject({ code: "interaction_unavailable" });
  } finally {
    await h.dispose();
  }
});

test("concurrent answers consume an async answer handle exactly once", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send([{ type: "text", text: "question" }], "steer");
    await h.wait(
      (f) =>
        obj(f.data).method === "item/completed" && obj(obj(obj(f.data).params).item).id === "q",
    );
    const results = await Promise.allSettled([
      h.session.resolve("async:q", { kind: "question", answers: { q0: ["tabs"] } }),
      h.session.resolve("async:q", { kind: "question", answers: { q0: ["spaces"] } }),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected"]);
    const rejected = results[1];
    if (rejected?.status !== "rejected") throw new Error("Duplicate answer succeeded");
    expect(rejected.reason).toMatchObject({ code: "interaction_unavailable" });
    expect(
      Object.values(h.replay.state.interactions).filter((i) => i.state === "resolved"),
    ).toHaveLength(1);
  } finally {
    await h.dispose();
  }
});
