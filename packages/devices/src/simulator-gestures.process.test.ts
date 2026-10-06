import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { ScreenManager, Helper, type HelperOptions } from "@ace/screen";
import { DevicePlatform } from "./index.ts";
const target = { kind: "window", windowId: 1, bundleId: "com.apple.iphonesimulator" } as const;
const command = {
  command: process.execPath,
  args: [new URL("./testing/gesture-helper.ts", import.meta.url).pathname],
};
const simulator = {
  id: "ios:11111111-1111-4111-8111-111111111111",
  name: "iPhone",
  platform: "ios",
  state: "booted",
} as const;
function ids() {
  let id = 0;
  return () => `gesture-${++id}`;
}
async function files() {
  const root = await mkdtemp(join(tmpdir(), "ace-gestures-"));
  onTestFinished(() => rm(root, { recursive: true, force: true }));
  return { root, journal: join(root, "input.jsonl") };
}
it("Simulator gestures use the captured window coordinates and preserve their duration without idb", async () => {
  const f = await files();
  const screen = new ScreenManager({
    ...command,
    env: { GESTURE_JOURNAL: f.journal },
    platform: "darwin",
    nextId: ids(),
    recordingDirectory: f.root,
    publishArtifact: async () => {},
  });
  const devices = new DevicePlatform({
    platform: "darwin",
    home: f.root,
    env: { PATH: "" },
    screen,
  });
  onTestFinished(async () => {
    await devices.close();
    await screen.close();
  });
  await screen.enable(true);
  await screen.approve(target.bundleId, true);
  const state = await screen.start(target);
  screen.controller(state.sessionId, "human", "user");
  const binding = { sessionId: state.sessionId, actor: "human", owner: "user" } as const;
  await devices.input(simulator, { kind: "longPress", x: 20, y: 40, durationMs: 750 }, binding);
  await devices.input(
    simulator,
    { kind: "swipe", x: 20, y: 40, toX: 80, toY: 60, durationMs: 1500 },
    binding,
  );
  expect(
    (await readFile(f.journal, "utf8"))
      .trim()
      .split("\n")
      .map((line): unknown => JSON.parse(line)),
  ).toEqual([
    {
      target: "com.apple.iphonesimulator:1",
      input: {
        kind: "pointer.drag",
        x: 20,
        y: 40,
        toX: 20,
        toY: 40,
        button: "left",
        durationMs: 750,
      },
    },
    {
      target: "com.apple.iphonesimulator:1",
      input: {
        kind: "pointer.drag",
        x: 20,
        y: 40,
        toX: 80,
        toY: 60,
        button: "left",
        durationMs: 1500,
      },
    },
  ]);
});
it("a ten-second gesture stays pending beyond the ordinary helper deadline and completes normally", async () => {
  const f = await files();
  let now = 0;
  const timers = new Map<number, { at: number; callback: () => void }>();
  let next = 0;
  const scheduler: NonNullable<HelperOptions["scheduler"]> = {
    schedule(callback, delay) {
      const id = ++next;
      timers.set(id, { at: now + delay, callback });
      return () => {
        timers.delete(id);
      };
    },
  };
  const helper = await Helper.open({
    ...command,
    env: { GESTURE_JOURNAL: f.journal, HOLD_DRAG: "1" },
    platform: "darwin",
    nextId: ids(),
    scheduler,
    onFrame: () => {},
    onFailure: () => {},
  });
  onTestFinished(() => helper.close());
  await helper.negotiate();
  const pending = helper.request({
    op: "input",
    input: { kind: "pointer.drag", x: 0, y: 0, toX: 1, toY: 1, button: "left", durationMs: 10000 },
  });
  now = 10000;
  for (const [id, timer] of timers)
    if (timer.at <= now) {
      timers.delete(id);
      timer.callback();
    }
  await helper.request({ op: "targets" });
  await expect(pending).resolves.toBeUndefined();
});
it("a Simulator lease revoked during a permission read prevents native input dispatch", async () => {
  const f = await files();
  const screen = new ScreenManager({
    ...command,
    env: { GESTURE_JOURNAL: f.journal, HOLD_PERMISSION: "1" },
    platform: "darwin",
    nextId: ids(),
    recordingDirectory: f.root,
    publishArtifact: async () => {},
  });
  const devices = new DevicePlatform({
    platform: "darwin",
    home: f.root,
    env: { PATH: "" },
    screen,
  });
  onTestFinished(async () => {
    await devices.close();
    await screen.close();
  });
  await screen.enable(true);
  await screen.approve(target.bundleId, true);
  const state = await screen.start(target);
  screen.controller(state.sessionId, "human", "user");
  let authorized = true;
  const binding = { sessionId: state.sessionId, actor: "human", owner: "user" } as const;
  const pending = devices.input(
    simulator,
    { kind: "longPress", x: 20, y: 40, durationMs: 750 },
    binding,
    () => {
      if (!authorized) throw new Error("Controller lease expired");
    },
  );
  const rejected = expect(pending).rejects.toThrow("Controller lease expired");
  const held = await screen.targets();
  expect(held.windows[0]?.title).toContain("heldPermission:true");
  authorized = false;
  await screen.targets();
  await rejected;
  await expect(readFile(f.journal)).rejects.toMatchObject({ code: "ENOENT" });
});

it("human Simulator taps, swipes and typing bypass agent focus rejection while agents remain guarded", async () => {
  const f = await files();
  const screen = new ScreenManager({
    ...command,
    env: { GESTURE_JOURNAL: f.journal, REJECT_BACKGROUND_FOCUS: "1" },
    platform: "darwin",
    nextId: ids(),
    recordingDirectory: f.root,
    publishArtifact: async () => {},
  });
  const devices = new DevicePlatform({
    platform: "darwin",
    home: f.root,
    env: { PATH: "" },
    screen,
  });
  onTestFinished(async () => {
    await devices.close();
    await screen.close();
  });
  await screen.enable(true);
  await screen.approve(target.bundleId, true);
  const state = await screen.start(target);
  screen.controller(state.sessionId, "human", "user");
  const human = { sessionId: state.sessionId, actor: "human", owner: "user" } as const;
  await devices.input(simulator, { kind: "tap", x: 20, y: 40 }, human);
  await devices.input(
    simulator,
    { kind: "swipe", x: 20, y: 40, toX: 80, toY: 60, durationMs: 100 },
    human,
  );
  await devices.input(simulator, { kind: "type", text: "hello" }, human);
  const delivered = (await readFile(f.journal, "utf8"))
    .trim()
    .split("\n")
    .map((line): unknown => JSON.parse(line));
  expect(delivered).toEqual([
    {
      target: "com.apple.iphonesimulator:1",
      input: { kind: "pointer.click", x: 20, y: 40, button: "left" },
    },
    {
      target: "com.apple.iphonesimulator:1",
      input: {
        kind: "pointer.drag",
        x: 20,
        y: 40,
        toX: 80,
        toY: 60,
        durationMs: 100,
        button: "left",
      },
    },
    { target: "com.apple.iphonesimulator:1", input: { kind: "text.type", text: "hello" } },
  ]);
  screen.controller(state.sessionId, "agent", "agent");
  await expect(
    devices.input(
      simulator,
      { kind: "tap", x: 20, y: 40 },
      { sessionId: state.sessionId, actor: "agent", owner: "agent" },
    ),
  ).rejects.toMatchObject({ code: "foreground_required" });
  expect((await readFile(f.journal, "utf8")).trim().split("\n")).toHaveLength(3);
});
