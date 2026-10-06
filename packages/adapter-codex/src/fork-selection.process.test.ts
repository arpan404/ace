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

test("turns use the latest effort and tier after reconfiguring a delegated session", async () => {
  const h = await sessionHarness(false, "", undefined, { effort: "high", serviceTier: "priority" });
  const lastStart = () =>
    obj(
      h.frames.findLast(
        (frame) => frame.dir === "send" && obj(frame.data)["method"] === "turn/start",
      )?.data,
    )["params"];
  try {
    await h.session.send([{ type: "text", text: "same-chunk" }], "queue");
    await h.wait((frame) => obj(frame.data)["method"] === "turn/completed");
    expect(lastStart()).toMatchObject({ effort: "high", serviceTier: "priority" });
    if (!h.session.configure) throw new Error("No native configuration");
    await h.session.configure({
      provider: "codex",
      model: "next-model",
      options: { effort: "low", serviceTier: "default" },
    });
    await h.session.send([{ type: "text", text: "same-chunk" }], "queue");
    expect(lastStart()).toMatchObject({ effort: "low", serviceTier: "default" });
  } finally {
    await h.dispose();
  }
});

test("Codex starts with a lifetime-scoped ace lease and redacts the native connection", async () => {
  const url = "http://127.0.0.1:12345/mcp";
  const bearer = "b".repeat(64);
  const h = await sessionHarness(false, "", undefined, undefined, {
    url,
    bearer,
    signal: new AbortController().signal,
    end: () => {},
  });
  try {
    const initialized = await h.wait(
      (frame) => obj(obj(obj(frame.data)["result"])["aceConnection"])["authenticated"] === true,
    );
    expect(obj(obj(initialized.data)["result"])["aceConnection"]).toEqual({
      url: JSON.stringify(url),
      authenticated: true,
    });
    await h.session.send([{ type: "text", text: "same-chunk" }], "queue");
    await h.wait((frame) => obj(frame.data)["method"] === "turn/completed");
    expect(JSON.stringify(h.frames)).not.toContain(bearer);
  } finally {
    await h.dispose();
  }
});

test("a native fork shows inherited asks and answers before its first new turn", async () => {
  const h = await sessionHarness(false, "", {
    nativeSessionId: "source-native",
    point: { type: "turn", nativeId: "source-turn" },
  });
  try {
    const messages = Object.values(h.replay.state.items).filter((i) => i.type === "message");
    const text = JSON.stringify(messages);
    expect(text).toContain("ask private native earlier context");
    expect(text).toContain("private native selected context");
    expect(text).not.toContain("private native future secret");
    expect(messages.filter((i) => i.type === "message" && i.role === "user")).toHaveLength(2);
    expect(messages.filter((i) => i.type === "message" && i.role === "assistant")).toHaveLength(2);
  } finally {
    await h.dispose();
  }
});
