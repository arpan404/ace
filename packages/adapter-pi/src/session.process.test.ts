import { expect, test } from "vitest";
import { openPiSession } from "./index.ts";
import { ThreadId } from "@ace/protocol";
import { sessionHarness } from "./testing/harness.ts";
import { obj, str } from "./native.ts";
const received = (type: string, id?: string) => (f: { dir: string; data: unknown }) =>
  f.dir === "recv" && obj(f.data).type === type && (id === undefined || obj(f.data).id === id);
const text = (value: string) => [{ type: "text" as const, text: value }];
test("explicit native resume reloads the saved session before any prompt", async () => {
  const h = await sessionHarness({}, true);
  try {
    expect(h.session.nativeSessionId).toBe("/synthetic/resumed.jsonl");
    expect(h.frames.filter((f) => f.dir === "send" && obj(f.data).type === "prompt")).toEqual([]);
  } finally {
    await h.dispose();
  }
});
test("steering and follow-up carry native delivery while Unicode separators stay in text", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(text("hello"), "steer");
    const proof = await h.wait(received("extension_ui_request", "input-proof"));
    expect(JSON.parse(str(obj(proof.data).message)).streamingBehavior).toBe("steer");
    await h.session.send(text("again"), "queue");
    expect(
      h.frames
        .filter((f) => f.dir === "send" && obj(f.data).type === "prompt")
        .map((f) => obj(f.data).streamingBehavior),
    ).toEqual(["steer", "followUp"]);
    expect(
      Object.values(h.h.state.items)
        .filter((item) => item.type === "message" && item.role === "assistant")
        .map((item) => (item.type === "message" ? item.parts : [])),
    ).toEqual([
      [{ type: "text", text: "hello\u2028world\u2029!" }],
      [{ type: "text", text: "hello\u2028world\u2029!" }],
    ]);
  } finally {
    await h.dispose();
  }
});
test("selection answers use native offered labels and cannot be sent twice", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(text("dialogs"), "queue");
    await h.wait(received("extension_ui_request", "select"));
    await expect(
      h.session.resolve("select", { kind: "question", answers: { select: ["9"] } }),
    ).rejects.toThrow("Unknown Pi selection");
    await h.session.resolve("select", { kind: "question", answers: { select: ["1"] } });
    const proof = await h.wait(received("extension_ui_request", "answer-proof"));
    expect(JSON.parse(str(obj(proof.data).message))).toMatchObject({
      id: "select",
      value: "Spaces",
    });
    await expect(
      h.session.resolve("select", { kind: "question", answers: { select: ["0"] } }),
    ).rejects.toThrow("no longer pending");
  } finally {
    await h.dispose();
  }
});
test("timed dialogs expire without withdrawing unrelated editor input", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(text("dialogs"), "queue");
    await h.wait(received("extension_ui_request", "timed"));
    h.expireDialogs();
    await expect(
      h.session.resolve("timed", { kind: "question", answers: { timed: ["late"] } }),
    ).rejects.toThrow("no longer pending");
    await h.session.resolve("editor", { kind: "question", answers: { editor: ["new\ntext"] } });
    const proof = await h.wait(received("extension_ui_request", "answer-proof"));
    expect(JSON.parse(str(obj(proof.data).message))).toMatchObject({
      id: "editor",
      value: "new\ntext",
    });
  } finally {
    await h.dispose();
  }
});
test("generic confirmation is a yes/no question and replies with native confirmed", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(text("dialogs"), "queue");
    await h.wait(received("extension_ui_request", "confirm"));
    expect(h.h.state.interactions.confirm?.request.kind).toBe("question");
    await h.session.resolve("confirm", { kind: "question", answers: { confirm: ["no"] } });
    const proof = await h.wait(received("extension_ui_request", "answer-proof"));
    expect(JSON.parse(str(obj(proof.data).message))).toMatchObject({
      id: "confirm",
      confirmed: false,
    });
  } finally {
    await h.dispose();
  }
});
test("native fork creates a resumable reference and preserves the source session", async () => {
  const h = await sessionHarness();
  try {
    const result = await h.session.fork();
    expect(result.nativeSessionId).toBe("/synthetic/fork.jsonl");
    expect(h.session.nativeSessionId).toBe("/synthetic/source.jsonl");
    await h.session.send(text("proof"), "queue");
    const states = h.frames.filter(
      (f) => received("response")(f) && obj(f.data).command === "get_state",
    );
    expect(obj(obj(states.at(-1)?.data).data).sessionFile).toBe("/synthetic/source.jsonl");
  } finally {
    await h.dispose();
  }
});
test("cancelled native fork fails without submitting the selected prompt", async () => {
  const h = await sessionHarness({}, false, { FAKE_PI_CANCEL_FORK: "1" });
  try {
    await expect(h.session.fork("entry")).rejects.toThrow("cancelled fork");
    expect(h.frames.filter((f) => f.dir === "send" && obj(f.data).type === "prompt")).toEqual([]);
  } finally {
    await h.dispose();
  }
});
test("native rollback requires an extension acknowledgement and redacts its control secret", async () => {
  const h = await sessionHarness();
  try {
    await h.session.rollback("entry");
    expect(h.session.nativeSessionId).toBe("/synthetic/source.jsonl");
    expect(JSON.stringify(h.frames)).not.toContain("a".repeat(64));
    expect(h.frames.some((f) => received("agent_start")(f))).toBe(false);
  } finally {
    await h.dispose();
  }
});
test("an accepted rollback command without acknowledgement is not success", async () => {
  const h = await sessionHarness({}, false, { FAKE_PI_MISSING_ACK: "1" });
  try {
    await expect(h.session.rollback("entry")).rejects.toThrow("not acknowledged");
  } finally {
    await h.dispose();
  }
});
test("cancelled native navigation does not become successful rollback", async () => {
  const h = await sessionHarness({}, false, { FAKE_PI_CANCEL_ROLLBACK: "1" });
  try {
    await expect(h.session.rollback("entry")).rejects.toThrow("not acknowledged");
  } finally {
    await h.dispose();
  }
});
test("interrupt clears native queued continuation before aborting", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(text("queued"), "steer");
    await h.session.interrupt({ cascade: true });
    const proof = await h.wait(received("extension_ui_request", "abort-proof"));
    expect(obj(proof.data).message).toBe("queue cleared");
    expect(h.h.state.status.state).toBe("done");
  } finally {
    await h.dispose();
  }
});
test("unknown versions and unsupported permissions are refused before process launch", async () => {
  const context = {
    threadId: ThreadId.parse("test"),
    cwd: process.cwd(),
    signal: new AbortController().signal,
    onFrame() {},
    onExit() {},
  };
  const runtime = {
    spawn() {
      throw new Error("must not launch");
    },
  };
  await expect(
    openPiSession(context, {
      cli: { installed: true, path: "fake", version: "1.0.0", auth: "unknown", loginHint: "none" },
      runtime,
    }),
  ).rejects.toThrow("unsupported");
  await expect(
    openPiSession(context, {
      cli: { installed: true, path: "fake", version: "0.85.1", auth: "unknown", loginHint: "none" },
      permissionMode: "supervised",
      runtime,
    }),
  ).rejects.toThrow("cannot enforce");
});
test("missing ace extension fails startup without falling through to a model prompt", async () => {
  await expect(sessionHarness({}, false, { FAKE_PI_EXTENSION_MISSING: "1" })).rejects.toThrow(
    "extension did not load",
  );
});
test("unrepresentable blocking dialogs close the transport without reporting completion", async () => {
  const h = await sessionHarness();
  try {
    await expect(h.session.send(text("large-dialog"), "queue")).rejects.toThrow("closed");
    expect(h.h.state.status.state).not.toBe("done");
    await expect(h.session.send(text("later"), "queue")).rejects.toThrow("closed");
  } finally {
    await h.dispose();
  }
});

test("oversized input and reserved commands fail without provider delivery", async () => {
  const h = await sessionHarness();
  try {
    await expect(h.session.send(text("x".repeat(1024 * 1024 + 1)), "queue")).rejects.toThrow(
      "budget",
    );
    await expect(h.session.send(text("/ace-rollback attempted"), "queue")).rejects.toThrow(
      "Reserved",
    );
    expect(
      h.frames.filter((frame) => frame.dir === "send" && obj(frame.data).type === "prompt"),
    ).toEqual([]);
  } finally {
    await h.dispose();
  }
});
test("native image data and file references are sent without fetching remote URLs", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(
      [
        { type: "file", path: "/synthetic/image.png" },
        { type: "image", mimeType: "image/png", url: "data:image/png;base64,AAAA" },
      ],
      "queue",
    );
    const proof = await h.wait(received("extension_ui_request", "input-proof"));
    expect(JSON.parse(str(obj(proof.data).message))).toMatchObject({
      message: "File: /synthetic/image.png",
      images: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
    });
    await expect(
      h.session.send(
        [{ type: "image", mimeType: "image/png", url: "https://example.invalid/image.png" }],
        "queue",
      ),
    ).rejects.toThrow("base64");
  } finally {
    await h.dispose();
  }
});
test("opening failure revokes the injected ace MCP lease", async () => {
  const lifetime = new AbortController();
  let revoked = false;
  await expect(
    sessionHarness(
      {
        openMcp(_ctx, signal) {
          signal.addEventListener("abort", () => lifetime.abort(), { once: true });
          return {
            url: "http://127.0.0.1:1/mcp",
            bearer: "b".repeat(64),
            end() {
              revoked = true;
            },
          };
        },
      },
      false,
      { FAKE_PI_EXTENSION_MISSING: "1" },
    ),
  ).rejects.toThrow("extension did not load");
  expect(revoked).toBe(true);
  expect(lifetime.signal.aborted).toBe(true);
});

test("read-only launch withholds write tools and never grants an ace MCP lease", async () => {
  const h = await sessionHarness({
    permissionMode: "read_only",
    openMcp() {
      throw new Error("read-only must not grant MCP");
    },
  });
  try {
    await h.session.send(text("write-proof"), "queue");
    await h.wait(received("message_end"));
    expect(
      Object.values(h.h.state.items)
        .filter((item) => item.type === "message" && item.role === "assistant")
        .map((item) => (item.type === "message" ? item.parts : [])),
    ).toEqual([[{ type: "text", text: "write unavailable" }]]);
  } finally {
    await h.dispose();
  }
});
test("MCP bearer echoes are redacted before raw frames and lease ends on close", async () => {
  let ended = false;
  const h = await sessionHarness({
    openMcp() {
      return {
        url: "http://127.0.0.1:1/mcp",
        bearer: "b".repeat(64),
        end() {
          ended = true;
        },
      };
    },
  });
  try {
    await h.session.send(text("env-proof"), "queue");
    await h.wait(received("message_end"));
    const frames = JSON.stringify(h.frames);
    expect(frames).not.toContain("b".repeat(64));
    expect(frames).toContain("<ACE_LEASE>");
  } finally {
    await h.dispose();
  }
  expect(ended).toBe(true);
});
