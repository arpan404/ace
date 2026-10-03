import { expect, test } from "vitest";
import { sessionHarness } from "./session.test-helper.ts";
import { obj, str } from "./native.ts";
test("native forks copy the requested source through the chosen turn into a different session", async () => {
  const h = await sessionHarness(false, "", {
    nativeSessionId: "source-native",
    point: { type: "turn", nativeId: "source-turn" },
  });
  try {
    expect(h.session.nativeSessionId).toBe("fork-native");
    await h.session.send([{ type: "text", text: "continue this fork" }], "queue");
    const continuation = await h.wait(
      (frame) =>
        frame.dir === "recv" &&
        obj(obj(obj(frame.data)["params"])["item"])["id"] === "fork-history-proof",
    );
    const text = str(obj(obj(obj(continuation.data)["params"])["item"])["text"]);
    expect(text).toContain("private native earlier context");
    expect(text).toContain("private native selected context");
    expect(text).toContain("answer: continue this fork");
    expect(text).not.toContain("private native future secret");
  } finally {
    await h.dispose();
  }
});
test("model and effort changes reach the native session settings without replacing its identity", async () => {
  const h = await sessionHarness();
  try {
    if (!h.session.configure) throw new Error("No live native configuration");
    const nativeId = h.session.nativeSessionId;
    await h.session.configure({
      provider: "codex",
      model: "selected-model",
      options: { effort: "high", serviceTier: "priority" },
    });
    const applied = await h.wait(
      (frame) =>
        frame.dir === "recv" &&
        obj(obj(obj(frame.data)["params"])["item"])["id"] === "configuration-proof",
    );
    expect(JSON.parse(str(obj(obj(obj(applied.data)["params"])["item"])["text"]))).toEqual({
      model: "selected-model",
      effort: "high",
      serviceTier: "priority",
    });
    expect(h.session.nativeSessionId).toBe(nativeId);
  } finally {
    await h.dispose();
  }
});
