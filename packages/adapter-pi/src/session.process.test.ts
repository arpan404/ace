import { expect, test } from "vitest";
import type { Frame } from "@ace/engine-api";
import { createPiTranslator, openPiSession } from "./index.ts";
import { ThreadId } from "@ace/protocol";
import { spawnTextSupervised } from "@ace/provider-kit/process";
import { sessionBackend } from "@ace/provider-kit/native-switches";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionHarness } from "./testing/harness.ts";
import { sessionFixture } from "./testing/native-history.ts";
import { openNativePiSession, type NativeSessionsAddon } from "./native-session.ts";
import { obj, str } from "./native.ts";
const received = (type: string, id?: string) => (f: { dir: string; data: unknown }) =>
  f.dir === "recv" && obj(f.data).type === type && (id === undefined || obj(f.data).id === id);
const text = (value: string) => [{ type: "text" as const, text: value }];
test("compaction is Pi's own compact command, and its result is one compaction row", async () => {
  const h = await sessionHarness();
  try {
    await h.session.compact?.();
    expect(h.frames.filter((f) => f.dir === "send" && obj(f.data).type === "compact")).toHaveLength(
      1,
    );
    await h.wait(received("compaction_end"));
    expect(
      Object.values(h.h.state.items).filter((item) => item.type === "compaction"),
    ).toMatchObject([
      {
        summary: "The earlier turns, summarised by Pi.",
        tokensBefore: 150_000,
        tokensAfter: 32_000,
      },
    ]);
  } finally {
    await h.dispose();
  }
});

test("a Stop reaches Pi while its compaction is still running, and ends it", async () => {
  const h = await sessionHarness({}, false, { FAKE_PI_SLOW_COMPACT: "1" });
  try {
    // The ask does not wait for Pi's reply (the summary), so this resolves at once.
    await h.session.compact?.();
    await h.wait(received("compaction_start"));
    await h.session.interrupt({ cascade: true });
    const sent = h.frames.filter((f) => f.dir === "send").map((f) => str(obj(f.data).type));
    expect(sent.slice(sent.indexOf("compact"))).toEqual(
      expect.arrayContaining(["abort", "abort_bash"]),
    );
    // The provider's own end of the aborted compaction still settles the thread.
    await h.wait(received("compaction_end"));
    expect(Object.values(h.h.state.items).filter((item) => item.type === "compaction")).toEqual([]);
  } finally {
    await h.dispose();
  }
});

test("explicit native resume reloads the saved session before any prompt", async () => {
  const h = await sessionHarness({}, true);
  try {
    expect(h.session.nativeSessionFile).toBe(h.resumedPath);
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
    expect(result.nativeSessionId).not.toBe(h.session.nativeSessionId);
    expect(h.session.nativeSessionFile).toBe(h.sourcePath);
    await h.session.send(text("proof"), "queue");
    const states = h.frames.filter(
      (f) => received("response")(f) && obj(f.data).command === "get_state",
    );
    expect(obj(obj(states.at(-1)?.data).data).sessionFile).toBe(h.sourcePath);
  } finally {
    await h.dispose();
  }
});
test("cancelled native fork fails without submitting the selected prompt", async () => {
  const h = await sessionHarness({}, false, { FAKE_PI_CANCEL_FORK: "1" });
  try {
    await expect(h.session.fork("second-user")).rejects.toThrow("cancelled fork");
    expect(h.frames.filter((f) => f.dir === "send" && obj(f.data).type === "prompt")).toEqual([]);
  } finally {
    await h.dispose();
  }
});
test("native rollback requires an extension acknowledgement and redacts its control secret", async () => {
  const secret = "a".repeat(64);
  let next = 0;
  const h = await sessionHarness({
    runtime: { secret: () => (next++ === 0 ? secret : "c".repeat(64)) },
  });
  try {
    await h.session.rollback("entry");
    expect(h.session.nativeSessionFile).toBe(h.sourcePath);
    await h.wait(
      (frame) =>
        frame.dir === "stderr" &&
        typeof frame.data === "string" &&
        frame.data.includes("<ACE_CONTROL>"),
    );
    for (const dir of ["send", "recv", "stderr"]) {
      const encoded = JSON.stringify(h.frames.filter((frame) => frame.dir === dir));
      expect(encoded).not.toContain(secret);
      expect(encoded).toContain("<ACE_CONTROL>");
    }
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
const nativeOnly = sessionBackend("pi") === "native";
/** A loaded addon whose session constructor throws, as a stale build can. */
function staleAddon(): never {
  throw new Error("stale addon");
}
/** Rejects after `ms`: a paused session that never resumes must fail, not hang the file. */
const later = (ms: number, message: string) =>
  new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(message)), ms));
async function until(done: () => boolean, ms: number, message: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
test.skipIf(!nativeOnly)(
  "a stale native handle releases the lease before a credential file exists",
  async () => {
    let ended = false;
    await expect(
      openNativePiSession(
        {
          threadId: ThreadId.parse("native-throw"),
          cwd: process.cwd(),
          signal: new AbortController().signal,
          onFrame() {},
          onExit() {},
        },
        {
          cli: {
            installed: true,
            path: "synthetic-pi",
            version: "0.85.1",
            auth: "unknown",
            loginHint: "none",
          },
          openMcp() {
            return {
              url: "http://127.0.0.1:1/mcp",
              bearer: "b".repeat(64),
              end() {
                ended = true;
              },
            };
          },
        },
        () => ({ PiSessionNative: staleAddon }) as unknown as NativeSessionsAddon,
      ),
    ).rejects.toThrow("stale addon");
    expect(ended).toBe(true);
  },
);
test.skipIf(!nativeOnly)(
  "engine backpressure pauses the diverted child and a resume delivers the next frame",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "ace-pi-flow-"));
    await writeFile(join(home, "source.jsonl"), sessionFixture(home, "native", 3));
    const controller = new AbortController();
    let paused = false;
    let release: (() => void) | undefined;
    let frames = 0;
    let settled = false;
    const session = await openPiSession(
      {
        threadId: ThreadId.parse("pi-flow"),
        rootKey: "root",
        cwd: process.cwd(),
        env: { FAKE_PI_HOME: home },
        signal: controller.signal,
        outputFlow: {
          paused: () => paused,
          wait: () =>
            new Promise<void>((resolve) => {
              release = resolve;
            }),
        },
        onFrame(frame) {
          frames++;
          if (frame.dir === "recv" && obj(frame.data).type === "agent_end") settled = true;
        },
        onExit() {},
      },
      {
        sessionReferenceDir: join(home, "references"),
        cli: {
          installed: true,
          path: "synthetic-pi",
          version: "0.85.1",
          auth: "unknown",
          loginHint: "none",
        },
        runtime: {
          now: () => 0,
          secret: () => "c".repeat(64),
          schedule: (callback, ms) => {
            const timer = setTimeout(callback, ms);
            return () => clearTimeout(timer);
          },
          spawn: (options) =>
            spawnTextSupervised({
              ...options,
              command: process.execPath,
              args: [
                fileURLToPath(new URL("./testing/fake-pi.ts", import.meta.url)),
                ...(options.args ?? []),
              ],
            }),
        },
      },
    );
    let passed = false;
    try {
      frames = 0;
      paused = true;
      const image = Buffer.alloc(300 * 1024, 7).toString("base64");
      const sent = session.send(
        [
          { type: "text", text: "image-echo" },
          { type: "image", mimeType: "image/png", url: `data:image/png;base64,${image}` },
        ],
        "queue",
      );
      // The first frame after the pause makes the bridge pause the child; a reply larger
      // than one chunk then leaves its pump stopped at the gate until the resume below.
      await until(() => frames > 0, 5_000, "no frame arrived");
      await new Promise((resolve) => setTimeout(resolve, 400));
      paused = false;
      release?.();
      release = undefined;
      await Promise.race([sent, later(5_000, "paused output never resumed")]);
      await until(() => settled, 10_000, "the turn after the resume never ended");
      passed = true;
    } finally {
      // A paused pump that never resumes would leave close waiting for Drained forever.
      await Promise.race([
        session.close("shutdown"),
        later(2_000, passed ? "close" : "close after the red run"),
      ]).catch(() => {});
      controller.abort();
      await rm(home, { recursive: true, force: true });
    }
  },
);
test.skipIf(!nativeOnly)(
  "a failed stop leaves the session stop-only and a retried close still finishes",
  async () => {
    let attempts = 0;
    const h = await sessionHarness({
      runtime: {
        spawn: (options) => {
          const proc = spawnTextSupervised({
            ...options,
            command: process.execPath,
            args: [
              fileURLToPath(new URL("./testing/fake-pi.ts", import.meta.url)),
              ...(options.args ?? []),
            ],
          });
          const stop = proc.stop.bind(proc);
          proc.stop = async (opts) => {
            attempts++;
            if (attempts === 1) throw new Error("stop failed");
            return stop(opts);
          };
          return proc;
        },
      },
    });
    try {
      await expect(h.session.close("shutdown")).rejects.toThrow("stop failed");
      // No write follows a failed stop: the retry alone is left.
      await expect(h.session.send(text("late"), "queue")).rejects.toThrow("Pi session closed");
      expect(
        h.frames.filter((frame) => frame.dir === "send" && obj(frame.data).type === "prompt"),
      ).toEqual([]);
      await h.session.close("shutdown");
    } finally {
      await h.dispose();
    }
  },
);
test("Pi releases older than 0.85.1 are refused before process launch, naming the supported range", async () => {
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
      cli: { installed: true, path: "fake", version: "0.84.4", auth: "unknown", loginHint: "none" },
      runtime,
    }),
  ).rejects.toMatchObject({
    code: "cli_too_old",
    cli: "pi",
    installed: "0.84.4",
    required: "0.85.1",
    message:
      "Pi 0.84.4 is older than 0.85.1, the oldest version ace supports. Update Pi, then refresh.",
  });
});
test("missing ace extension fails startup without falling through to a model prompt", async () => {
  await expect(sessionHarness({}, false, { FAKE_PI_EXTENSION_MISSING: "1" })).rejects.toThrow(
    "extension did not load",
  );
});
test("a Pi that exits on startup has said why on stderr before the open fails, and it is no transcript row", async () => {
  const frames: Frame[] = [];
  await expect(
    sessionHarness({}, false, { FAKE_PI_LOAD_FAILURE: "1" }, undefined, undefined, frames),
  ).rejects.toThrow();
  const stderr = frames.filter((frame) => frame.dir === "stderr").map((frame) => frame.data);
  expect(stderr).toEqual([
    expect.stringContaining("Failed to load extension"),
    'Hint: Start without extensions using "pi -ne".',
  ]);
  const translator = createPiTranslator({
    threadId: ThreadId.parse("thread"),
    rootKey: "root",
  });
  const facts = frames.flatMap((frame) => translator.translate(frame, 0));
  expect(facts.some((fact) => fact.type === "item.upsert" && fact.draft.type === "notice")).toBe(
    false,
  );
});
test("a flood of oversized stderr lines is dropped under one note and the session keeps working", async () => {
  const h = await sessionHarness({}, false, { FAKE_PI_STDERR_FLOOD: "1" });
  try {
    await h.wait((f) => f.dir === "stderr" && f.data === "still here");
    await h.session.send(text("hello"), "queue");
    await h.wait(received("agent_end"));
    expect(h.frames.filter((f) => f.dir === "stderr").map((f) => f.data)).toEqual([
      "ace dropped a stderr line of 1048577 bytes",
      "still here",
    ]);
  } finally {
    await h.dispose();
  }
});
test("stderr segments split by a bare CR are separate lines, so the session keeps working", async () => {
  const h = await sessionHarness({}, false, { FAKE_PI_STDERR_CR: "1" });
  try {
    await h.wait((f) => f.dir === "stderr" && f.data === "still here");
    await h.session.send(text("hello"), "queue");
    await h.wait(received("agent_end"));
    const stderr = h.frames.filter((f) => f.dir === "stderr").map((f) => String(f.data));
    expect(stderr.map((line) => line.length)).toEqual([600 * 1024, 600 * 1024, 10]);
  } finally {
    await h.dispose();
  }
});
test("unrepresentable blocking dialogs close the transport without reporting completion", async () => {
  const h = await sessionHarness();
  try {
    await expect(h.session.send(text("unanswerable-dialog"), "queue")).rejects.toThrow("closed");
    expect(h.h.state.status.state).not.toBe("done");
    await expect(h.session.send(text("later"), "queue")).rejects.toThrow("closed");
  } finally {
    await h.dispose();
  }
});

test("a Pi session with 200 open dialogs stays connected and answers the last one", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(text("many-dialogs"), "queue");
    await h.wait(received("extension_ui_request", "many-199"));
    expect(Object.keys(h.h.state.interactions)).toHaveLength(200);
    await h.session.resolve("many-199", {
      kind: "question",
      answers: { "many-199": ["yes"] },
    });
    const proof = await h.wait(received("extension_ui_request", "answer-proof"));
    expect(JSON.parse(str(obj(proof.data).message))).toMatchObject({
      id: "many-199",
      confirmed: true,
    });
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

test("Pi RPC prompts carry original image MIME and base64 bytes", async () => {
  const imageData = (
    await (
      await import("node:fs/promises")
    ).readFile(new URL("../../context/fixtures/colours.jpg", import.meta.url))
  ).toString("base64");

  const h = await sessionHarness();
  try {
    await h.session.send(
      [
        ...text("hello"),
        { type: "image", mimeType: "image/jpeg", url: `data:image/jpeg;base64,${imageData}` },
      ],
      "queue",
    );
    const frame = h.frames.find((f) => f.dir === "send" && obj(f.data).type === "prompt");
    expect(obj(frame?.data).images).toEqual([
      { type: "image", data: imageData, mimeType: "image/jpeg" },
    ]);
    expect(obj(frame?.data).message).toBe("hello");
  } finally {
    await h.dispose();
  }
});

test("the fake Pi CLI receives text, PDF and arbitrary binary paths", async () => {
  const h = await sessionHarness();
  try {
    await h.session.send(
      [
        { type: "file", path: "/files/code.ts", mimeType: "text/plain" },
        { type: "file", path: "/files/report.pdf", mimeType: "application/pdf" },
        { type: "file", path: "/files/archive.zip", mimeType: "application/zip" },
      ],
      "queue",
    );
    const proof = await h.wait(received("extension_ui_request", "input-proof"));
    expect(JSON.parse(str(obj(proof.data).message))).toMatchObject({
      message: "File: /files/code.ts\nFile: /files/report.pdf\nFile: /files/archive.zip",
    });
  } finally {
    await h.dispose();
  }
});
test("Pi echoing a run's images twice in one event does not end the session", async () => {
  const image = Buffer.alloc(600 * 1024);
  for (let i = 0; i < image.length; i++) image[i] = (i * 29 + (i >> 8)) % 256;
  const data = image.toString("base64");
  const h = await sessionHarness();
  try {
    await h.session.send(
      [
        ...text("image-echo"),
        { type: "image", mimeType: "image/png", url: `data:image/png;base64,${data}` },
      ],
      "queue",
    );
    expect(
      obj(h.frames.find((f) => f.dir === "send" && obj(f.data).type === "prompt")?.data).images,
    ).toEqual([{ type: "image", data, mimeType: "image/png" }]);
    // agent_end repeats the image in the user message and its tool result: past one line's limit.
    const end = await h.wait(received("agent_end"));
    expect(JSON.stringify(end.data)).not.toContain(data.slice(0, 4096));
    // The same session still answers the next prompt.
    await h.session.send(text("image-echo"), "queue");
    expect(h.frames.filter(received("agent_end"))).toHaveLength(2);
  } finally {
    await h.dispose();
  }
});
