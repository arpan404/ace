import { expect, test } from "vitest";
import type { Frame } from "@ace/engine-api";
import { apply, createThreadState } from "@ace/core";
import { ThreadId } from "@ace/protocol";
import { createTranslator } from "./index.ts";
import { harness, subtype } from "./session.test-helper.ts";
import { object } from "./native.ts";

/*
 * Claude Code installed the way npm installs it on Windows: a `.cmd` shim that cmd.exe runs.
 * The session helper launches its fake through such a shim on Windows, so the SDK's arguments
 * (JSON settings, the private MCP config path, session ids) cross the cmd.exe wrapper and the
 * shim's `%*` reparse, and every stop goes through the Windows tree stop.
 */
const windowsHost = process.platform === "win32";
const control = (kind: string) => (frame: Frame) =>
  subtype("fake_control")(frame) && object(object(frame.data)["request"])["subtype"] === kind;
const fakeInput = (frame: Frame) => object(object(frame.data)["input"]);

test.runIf(windowsHost)(
  "a .cmd-installed Claude handshakes, streams a turn and takes input under its session id",
  async () => {
    const h = await harness();
    try {
      await h.session.send([{ type: "text", text: "hello" }], "queue");
      const input = fakeInput(await h.wait(subtype("fake_input")));
      expect(input["session_id"]).toBe(h.session.nativeSessionId);
      expect(object(input["message"])["content"]).toEqual([{ type: "text", text: "hello" }]);
      await h.session.send([{ type: "text", text: "stream-probe" }], "queue");
      await h.wait((f) => object(f.data)["type"] === "result");
      const translator = createTranslator({ rootKey: "root" });
      const state = createThreadState({
        threadId: ThreadId.parse("probe"),
        config: { provider: "claude", silenceMs: 60_000 },
      });
      let id = 0;
      for (const f of h.frames)
        for (const fact of translator.translate(f, f.t))
          apply(state, fact, { now: f.t, ids: { next: (k) => `${k}:${++id}` } });
      expect(
        Object.values(state.items)
          .filter((i) => i.type === "message")
          .map((i) => i.parts),
      ).toContainEqual([{ type: "text", text: "partial answer" }]);
    } finally {
      await h.session.close("user");
    }
    expect(await h.exit).toMatchObject({ deliberate: true });
  },
);

test.runIf(windowsHost)(
  "an approval answered on Windows reaches Claude once with its permission update",
  async () => {
    const h = await harness();
    try {
      await h.session.send([{ type: "text", text: "approval" }], "queue");
      const frame = await h.wait((f) => f.channel === "can_use_tool");
      const id = String(object(object(frame.data)["options"])["requestId"]);
      await h.session.resolve(id, { kind: "approval", optionId: "allow_updates" });
      const response = object(
        object(object((await h.wait(subtype("fake_resolution"))).data)["response"])["response"],
      );
      expect(response["updatedPermissions"]).toEqual([
        { type: "setMode", mode: "acceptEdits", destination: "session" },
      ]);
      await expect(h.session.resolve(id, { kind: "approval", optionId: "deny" })).rejects.toThrow(
        "no longer pending",
      );
    } finally {
      await h.session.close("user");
    }
  },
);

test.runIf(windowsHost)(
  "model and effort chosen on Windows reach Claude without replacing its session",
  async () => {
    const h = await harness();
    try {
      if (!h.session.configure) throw new Error("Live configuration is required");
      const nativeId = h.session.nativeSessionId;
      await h.session.configure({
        provider: "claude",
        model: "next-model",
        options: { effort: "high", serviceTier: "fast" },
      });
      const model = await h.wait(control("set_model"));
      expect(object(object(model.data)["request"])["model"]).toBe("next-model");
      const flags = await h.wait(control("apply_flag_settings"));
      expect(object(object(flags.data)["request"])["settings"]).toMatchObject({
        effortLevel: "high",
        fastMode: true,
      });
      expect(h.session.nativeSessionId).toBe(nativeId);
    } finally {
      await h.session.close("shutdown");
    }
  },
);

test.runIf(windowsHost)(
  "interrupting a Claude turn on Windows uses the SDK interrupt and keeps the CLI running",
  async () => {
    const h = await harness();
    try {
      await h.session.send([{ type: "text", text: "steer-wait" }], "queue");
      await h.wait(subtype("fake_input"));
      await h.session.interrupt({ cascade: false });
      await h.wait(control("interrupt"));
      await h.wait((f) => object(f.data)["terminal_reason"] === "aborted_streaming");
      expect(h.exits).toEqual([]);
      const before = h.frames.length;
      await h.session.send([{ type: "text", text: "after interrupt" }], "queue");
      await h.wait(
        (f) =>
          h.frames.indexOf(f) >= before &&
          subtype("fake_input")(f) &&
          JSON.stringify(object(fakeInput(f)["message"])["content"]).includes("after interrupt"),
      );
      expect(h.exits).toEqual([]);
    } finally {
      await h.session.close("shutdown");
    }
  },
);

test.runIf(windowsHost)(
  "closing a Windows Claude session ends the CLI through its input closing, before the forced stop",
  async () => {
    const h = await harness();
    await h.session.send([{ type: "text", text: "hello" }], "queue");
    await h.wait(subtype("fake_input"));
    const started = performance.now();
    await h.session.close("user");
    // The forced tree stop waits out a 5 s grace; ending stdin lets the CLI leave first.
    expect(performance.now() - started).toBeLessThan(4_000);
    expect(await h.exit).toMatchObject({ deliberate: true });
    expect(h.exits).toHaveLength(1);
  },
);

test.runIf(windowsHost)("engine cancellation closes a Windows Claude process once", async () => {
  const h = await harness();
  h.controller.abort();
  expect(await h.exit).toMatchObject({ deliberate: true });
  await h.session.close("shutdown");
  expect(h.exits).toHaveLength(1);
});

test.runIf(windowsHost)(
  "an unexpected Claude exit through the .cmd shim is reported once",
  async () => {
    const h = await harness();
    await h.session.send([{ type: "text", text: "crash" }], "queue");
    expect(await h.exit).toMatchObject({ deliberate: false });
    await expect(h.session.stopTask("task")).rejects.toThrow("closed");
    await h.session.close("shutdown");
    expect(h.exits).toHaveLength(1);
  },
);

test.runIf(windowsHost)(
  "resuming and forking on Windows pass the native session arguments through cmd.exe intact",
  async () => {
    const source = "cdf0f865-7bc2-4f24-9d5d-9d83be2a9da9";
    const message = "cdf0f865-7bc2-4f24-9d5d-9d83be2a9daa";
    const resumed = await harness(source);
    try {
      expect(resumed.session.nativeSessionId).toBe(source);
      const started = await resumed.wait(subtype("fake_control"));
      expect(object(started.data)["argv"]).toEqual(expect.arrayContaining([`--resume=${source}`]));
    } finally {
      await resumed.session.close("shutdown");
    }
    const forked = await harness(
      undefined,
      "root",
      {},
      { fork: { nativeSessionId: source, point: { type: "item", nativeId: message } } },
    );
    try {
      const started = await forked.wait(subtype("fake_control"));
      expect(object(started.data)["argv"]).toEqual(
        expect.arrayContaining([
          `--resume=${source}`,
          "--fork-session",
          `--resume-session-at=${message}`,
        ]),
      );
      expect(forked.session.nativeSessionId).not.toBe(source);
      await forked.session.send([{ type: "text", text: "continue branch" }], "queue");
      const input = fakeInput(await forked.wait(subtype("fake_input")));
      expect(input["session_id"]).toBe(forked.session.nativeSessionId);
    } finally {
      await forked.session.close("shutdown");
    }
  },
);
