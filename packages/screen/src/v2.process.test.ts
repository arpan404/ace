import { helperGate } from "./testing/gate.ts";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { onTestFinished, expect, it } from "vitest";
import { spawnSupervised, type SupervisedProcess } from "@ace/provider-kit/process";
import { ScreenCapabilities } from "@ace/protocol";
import {
  computerUseHandler,
  FrameDecoder,
  framePacket,
  Helper,
  localFrameEndpoint,
} from "./index.ts";
import { deferred, fakeCommand, ids, manager, ready, target } from "./testing/support.ts";

it("negotiates capabilities and preserves v1 helpers without inventing semantic support", async () => {
  for (const v2 of [false, true]) {
    const helper = await Helper.open({
      ...fakeCommand,
      env: { FAKE_V2: v2 ? "1" : "0", LEGACY_ONLY: v2 ? "0" : "1" },
      transport: v2 ? "endpoint" : "legacy",
      nextId: ids(),
      onFrame: () => {},
      onFailure: () => {},
    });
    onTestFinished(() => helper.close());
    const capabilities = await helper.negotiate();
    if (v2)
      expect(ScreenCapabilities.parse(capabilities)).toMatchObject({
        version: 2,
        uiTree: true,
        capture: { changeDriven: true },
      });
    else expect(capabilities).toBeUndefined();
    expect(await helper.request({ op: "permissions" })).toEqual({
      screenRecording: true,
      accessibility: true,
    });
  }
});
it("100 semantic actions stay in one owned process and return observable app changes", async () => {
  const children: SupervisedProcess[] = [];
  const f = await manager(
    { FAKE_V2: "1" },
    {
      spawn: (options) => {
        const child = spawnSupervised(options);
        children.push(child);
        return child;
      },
    },
  );
  onTestFinished(f.close);
  const state = await ready(f.screen);
  f.screen.controller(state.sessionId, "agent", "agent");
  const tools = computerUseHandler(f.screen, state.sessionId, "agent");
  const initial = await f.screen.uiTree(state.sessionId, {});
  for (let i = 0; i < 100; i++) await tools("screen_ui_act", { ref: "button", action: "press" });
  const updated = await f.screen.uiTree(state.sessionId, {});
  expect(updated.nodes[0]?.name).toBe(initial.nodes[0]?.name);
  expect(updated.nodes[0]?.children[1]?.value).toBe("100");
  expect(updated.nodes[0]?.children[0]?.ref).toBe(initial.nodes[0]?.children[0]?.ref);
  expect(children).toHaveLength(1);
  expect(children[0]?.signal.aborted).toBe(false);
  await f.close();
  expect(children[0]?.signal.aborted).toBe(true);
});
it("UI reads hold no capture lease and viewers release capture without restarting the helper", async () => {
  const f = await manager({ FAKE_V2: "1" });
  onTestFinished(f.close);
  const state = await ready(f.screen);
  expect(state.indicator).toBe(false);
  await f.screen.uiTree(state.sessionId, {});
  const title = (await f.screen.targets()).windows[0]?.title;
  expect(title).toContain("capture:false");
  const frames: number[] = [];
  const unsubscribe = f.screen.subscribe(state.sessionId, async (frame) => {
    frames.push(frame.header.sequence);
  });
  await f.screen.captureScreenshot(state.sessionId);
  expect(f.screen.state(state.sessionId).indicator).toBe(true);
  unsubscribe();
  // targets waits for outstanding capture transitions, then acknowledges native state.
  const released = (await f.screen.targets()).windows[0]?.title;
  expect(released).toContain("capture:false");
  expect(released?.split("pid:")[1]).toBe(title?.split("pid:")[1]);
  expect(frames.length).toBeGreaterThan(0);
});
it("semantic tools enforce approvals, owner takeover, stale refs and bounded trees", async () => {
  const f = await manager({ FAKE_V2: "1" });
  onTestFinished(f.close);
  const state = await ready(f.screen);
  f.screen.controller(state.sessionId, "agent", "agent");
  const handler = computerUseHandler(f.screen, state.sessionId, "agent");
  expect(await f.screen.uiTree(state.sessionId, { maxNodes: 1, maxDepth: 0 })).toMatchObject({
    truncated: true,
    nodes: [{ children: [] }],
  });
  expect(
    await f.screen.uiFind(state.sessionId, { query: { name: "Click" }, limit: 1 }),
  ).toMatchObject({ nodes: [{ ref: "button" }] });
  expect(
    await f.screen.uiAct(state.sessionId, "agent", { ref: "button", action: "expand" }, "agent"),
  ).toMatchObject({ fallback: true, mode: "background" });
  await expect(handler("screen_ui_act", { ref: "missing", action: "press" })).rejects.toMatchObject(
    { code: "target_gone" },
  );
  f.screen.controller(state.sessionId, "human", "human");
  await expect(handler("screen_ui_act", { ref: "button", action: "press" })).rejects.toThrow(
    "ownership",
  );
  await f.screen.approve(target.bundleId, false);
  await expect(handler("screen_ui_tree", {})).rejects.toThrow();
});
it("v2 damage and scale survive fragmented framing alongside legacy packets", () => {
  const payload = Buffer.from("pixels");
  const wire = framePacket(
    {
      version: 2,
      sessionId: "v2",
      seq: 10,
      ts: 100,
      width: 200,
      height: 100,
      scale: 2,
      codec: "jpeg",
      bytes: payload.length,
      dirtyRects: [{ x: 2, y: 4, w: 6, h: 8 }],
    },
    payload,
  );
  const received: unknown[] = [];
  const decoder = new FrameDecoder((frame) => received.push(frame));
  for (const byte of wire) decoder.push(Buffer.from([byte]));
  decoder.end();
  expect(received).toMatchObject([
    {
      header: { sequence: 10, timestamp: 100, scale: 2, dirtyRects: [{ x: 2, y: 4, w: 6, h: 8 }] },
      payload,
    },
  ]);
});
it("endpoint addresses are private and remain separate from the helper executable", async () => {
  const endpoint = await localFrameEndpoint("darwin", ids());
  onTestFinished(endpoint.close);
  expect(endpoint.uri).toBe(`unix:${endpoint.path}`);
  expect((await stat(dirname(endpoint.path))).mode & 0o777).toBe(0o700);
  const helper = await Helper.open({
    ...fakeCommand,
    nextId: ids(),
    endpoint: async () => endpoint,
    onFrame: () => {},
    onFailure: () => {},
  });
  onTestFinished(() => helper.close());
  await helper.negotiate();
  expect((await stat(endpoint.path)).mode & 0o777).toBe(0o600);
  const invalid = await localFrameEndpoint("darwin", ids());
  await expect(
    Helper.open({
      ...fakeCommand,
      nextId: ids(),
      endpoint: async () => ({ ...invalid, uri: "invalid" }),
      onFrame: () => {},
      onFailure: () => {},
    }),
  ).rejects.toThrow();
});

it("failed viewers release the last pixel lease and subscription churn cannot accumulate commands", async () => {
  const f = await manager({ FAKE_V2: "1" });
  onTestFinished(f.close);
  const state = await ready(f.screen);
  const released = deferred<void>();
  let active = false;
  f.screen.watch((next) => {
    if (next.indicator) active = true;
    else if (active && next.lifecycle === "live") released.resolve();
  });
  for (let i = 0; i < 256; i++) f.screen.subscribe(state.sessionId, async () => {})();
  f.screen.subscribe(state.sessionId, async () => {
    throw new Error("viewer disconnected");
  });
  await released.promise;
  expect((await f.screen.targets()).windows[0]?.title).toContain("capture:false");
  expect(f.screen.state(state.sessionId).lifecycle).toBe("live");
});
it("v2 failure retains the visible indicator until owned process cleanup completes", async () => {
  const stopping = deferred<void>(),
    release = deferred<void>(),
    failed = deferred<void>();
  const f = await manager(
    { FAKE_V2: "1" },
    {
      spawn(options) {
        const child = spawnSupervised(options);
        return {
          ...child,
          stop: async (settings) => {
            stopping.resolve();
            await release.promise;
            return child.stop(settings);
          },
        };
      },
    },
  );
  onTestFinished(f.close);
  const state = await ready(f.screen);
  f.screen.subscribe(state.sessionId, async () => {});
  await f.screen.captureScreenshot(state.sessionId);
  f.screen.watch((next) => {
    if (next.lifecycle === "failed") failed.resolve();
  });
  f.screen.controller(state.sessionId, "agent", "agent");
  const crash = expect(
    f.screen.action(state.sessionId, "agent", { kind: "type", text: "crash" }, "agent"),
  ).rejects.toThrow();
  try {
    await stopping.promise;
    expect(f.screen.state(state.sessionId)).toMatchObject({
      lifecycle: "stopping",
      indicator: true,
    });
  } finally {
    release.resolve();
  }
  await crash;
  await failed.promise;
  expect(f.screen.state(state.sessionId).indicator).toBe(false);
});
it("named key, Unicode, scroll and pointer operations use the existing v2 process", async () => {
  const f = await manager({ FAKE_V2: "1" });
  onTestFinished(f.close);
  const state = await ready(f.screen);
  f.screen.controller(state.sessionId, "agent", "agent");
  const handler = computerUseHandler(f.screen, state.sessionId, "agent");
  await handler("screen_key", { key: "Enter", modifiers: ["command"] });
  await handler("screen_type", { text: "こんにちは 👋" });
  await handler("screen_scroll", { dx: 0, dy: 20 });
  await handler("screen_click", { x: 10, y: 20 });
  await f.screen.input(state.sessionId, "agent", { kind: "pointer.move", x: 10, y: 20 }, "agent");
  await f.screen.input(
    state.sessionId,
    "agent",
    { kind: "pointer.drag", x: 10, y: 20, toX: 30, toY: 40 },
    "agent",
  );
  for (const [name, value] of [
    ["Typed text", "こんにちは 👋"],
    ["Last key", JSON.stringify({ key: "Enter", modifiers: ["command"] })],
    ["Scroll", JSON.stringify({ dx: 0, dy: 20 })],
    ["Pointer", JSON.stringify({ x: 30, y: 40 })],
  ])
    expect((await f.screen.uiFind(state.sessionId, { query: { name } })).nodes[0]?.value).toBe(
      value,
    );
});
it("oversized and deeply nested helper trees are rejected", async () => {
  for (const bad of ["nodes", "depth"]) {
    const f = await manager({ FAKE_V2: "1", BAD_TREE: bad });
    onTestFinished(f.close);
    const state = await ready(f.screen);
    await expect(f.screen.uiTree(state.sessionId, {})).rejects.toThrow();
  }
});
it("malformed capabilities fail closed rather than silently downgrading to v1", async () => {
  const f = await manager({ FAKE_V2: "1", BAD_CAPABILITIES: "1" });
  onTestFinished(f.close);
  await expect(ready(f.screen)).rejects.toThrow();
  expect(f.screen.states()).toEqual([]);
});

it("approval revocation cannot return a tree that was pending when access was removed", async () => {
  const gate = await helperGate();
  const f = await manager({ FAKE_V2: "1", READ_GATE_PORT: gate.port });
  onTestFinished(async () => {
    gate.release();
    await f.close();
    await gate.close();
  });
  const state = await ready(f.screen);
  const pending = expect(f.screen.uiTree(state.sessionId, {})).rejects.toThrow("approval");
  await gate.reached;
  const revoked = f.screen.approve(target.bundleId, false);
  gate.release();
  await revoked;
  await pending;
});
it("v2 stops capture before stalled publication and disable still terminates the idle host", async () => {
  const publishing = deferred<void>(),
    release = deferred<void>();
  let child: SupervisedProcess | undefined;
  const f = await manager(
    { FAKE_V2: "1" },
    {
      spawn(options) {
        child = spawnSupervised(options);
        return child;
      },
      publishArtifact: async () => {
        publishing.resolve();
        await release.promise;
      },
    },
  );
  onTestFinished(f.close);
  const state = await ready(f.screen);
  await f.screen.startRecording(state.sessionId);
  const stopped = f.screen.stop(state.sessionId);
  let disabled: Promise<void> | undefined;
  try {
    await publishing.promise;
    expect((await f.screen.targets()).windows[0]?.title).toContain("capture:false");
    expect(f.screen.state(state.sessionId).indicator).toBe(false);
    if (!child) throw new Error("Missing host process");
    expect(child.signal.aborted).toBe(false);
    disabled = f.screen.enable(false);
    await child.exited;
    expect(child.signal.aborted).toBe(true);
  } finally {
    release.resolve();
    await stopped;
    await disabled;
  }
});
