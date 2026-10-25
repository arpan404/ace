import { AgentId, AppDevice, DeviceState, ThreadId } from "@ace/protocol";
import { expect, test } from "vitest";
import { phoneDevicesView, type DevicesViewInput } from "./devices-view.ts";

const iphone = AppDevice.parse({
  id: "ios:7d1b2c4e-5a6f-4e8d-9b0a-1c2d3e4f5a6b",
  platform: "ios",
  name: "iPhone 17 Pro",
  state: "booted",
  runtime: "iOS 26.0",
});
const ipad = AppDevice.parse({
  id: "ios:11111111-2222-3333-4444-555555555555",
  platform: "ios",
  name: "iPad Air 13-inch",
  state: "shutdown",
  runtime: "iOS 26.0",
});
const pixel = AppDevice.parse({
  id: "android:Pixel_9_API_35",
  platform: "android",
  name: "Pixel 9",
  state: "shutdown",
  runtime: "Android 15",
});
const claude = { threadId: ThreadId.parse("thread-1"), agentId: AgentId.parse("root") };

const live = (extra: Partial<DeviceState> = {}) =>
  DeviceState.parse({
    device: iphone,
    enabled: true,
    lifecycle: "live",
    streamId: "s1",
    controller: "none",
    ...extra,
  });

function view(states: DeviceState[], extra: Partial<DevicesViewInput> = {}) {
  return phoneDevicesView({
    snapshot: {
      connected: true,
      inventoryLoaded: true,
      devices: [iphone, ipad, pixel],
      states,
      issues: [],
      enabled: true,
    },
    closed: false,
    threadId: "thread-1",
    deviceId: iphone.id,
    query: "",
    platform: "all",
    now: 1_000,
    agent: (holder) =>
      holder.agentId === "root" ? { name: "Claude", provider: "claude" } : undefined,
    previous: new Map(),
    ...extra,
  });
}

test("an agent of this thread driving a device reads as one sentence with Take over, and the screen waits", () => {
  const shown = view([live({ controller: "agent", holder: claude })]);

  expect(shown.device?.control).toEqual({
    sentence: "Claude is using iPhone 17 Pro",
    action: "take",
  });
  expect(shown.device?.interactive).toBe(false);
  expect(shown.running[0]?.control).toBe("Claude is using it");
});

test("an agent of another thread is never given this thread's agent's name", () => {
  const shown = view([
    live({
      controller: "agent",
      holder: { threadId: ThreadId.parse("thread-2"), agentId: AgentId.parse("root") },
    }),
  ]);

  expect(shown.device?.control.sentence).toBe("An agent in another thread is using iPhone 17 Pro");
});

test("taken over from an agent, the person hands it back to that agent; otherwise they release it", () => {
  const yours = live({ controller: "human", ownedHere: true, leaseExpiresAt: 60_000 });

  const fromAgent = view([yours], { previous: new Map([[iphone.id, claude]]) });
  expect(fromAgent.device?.control).toEqual({
    sentence: "You're in control",
    action: "handBack",
    holder: claude,
  });
  expect(fromAgent.device?.interactive).toBe(true);

  expect(view([yours]).device?.control).toEqual({
    sentence: "You're in control",
    action: "release",
  });
});

test("control that ran out, or another person's, is said plainly and offers Take over", () => {
  const ended = view([live({ controller: "human", ownedHere: true, leaseExpiresAt: 900 })]).device;
  expect(ended?.control).toEqual({ sentence: "Your control ended", action: "take" });

  const other = view([
    live({ controller: "human", ownedHere: false, leaseExpiresAt: 60_000 }),
  ]).device;
  expect(other?.control).toEqual({ sentence: "Someone else is in control", action: "take" });
  expect(other?.interactive).toBe(false);
});

test("nobody in control leaves the line empty and the live screen touchable", () => {
  const device = view([live()]).device;
  expect(device?.control).toEqual({ sentence: "", action: "" });
  expect(device?.interactive).toBe(true);
  expect(device?.subtitle).toBe("iOS 26.0 · Live");
});

test("running devices list first; the Start sheet groups the rest by kind and narrows by search", () => {
  const shown = view([live()]);
  expect(shown.running.map((tile) => [tile.name, tile.detail])).toEqual([
    ["iPhone 17 Pro", "iOS 26.0 · Live"],
  ]);
  expect(shown.groups.map((group) => [group.label, group.rows.map((row) => row.name)])).toEqual([
    ["iPad", ["iPad Air 13-inch"]],
    ["Android phone", ["Pixel 9"]],
  ]);

  const searched = view([live()], { query: "pixel" });
  expect(searched.groups.map((group) => group.label)).toEqual(["Android phone"]);
  const filtered = view([live()], { platform: "ios" });
  expect(filtered.groups.map((group) => group.label)).toEqual(["iPad"]);
});

test("the agent's newest action reads as a caption at the point it landed, with its provider", () => {
  const device = view([
    live({
      controller: "agent",
      holder: claude,
      activity: {
        sequence: 3,
        action: "press",
        ref: "e7",
        label: "Sign in",
        point: { x: 20, y: 40 },
      },
    }),
  ]).device;

  expect(device?.activity).toEqual({
    sequence: 3,
    caption: "tap @e7 “Sign in”",
    provider: "claude",
    x: 20,
    y: 40,
  });
});

test("an iPhone offers the side buttons ace can press and a frame shaped like its own model", () => {
  const device = view([live()]).device;

  expect(device?.buttons.map((button) => button.key)).toEqual([
    "action",
    "volumeUp",
    "volumeDown",
    "power",
  ]);
  // The iPhone 17 Pro's own screen, until its first picture, with its display's 62pt corners.
  expect(device?.screen).toEqual({ width: 402, height: 874 });
  expect((device?.frame.portrait.screenRadius ?? 0) * 402).toBeCloseTo(62, 5);
  // On its side the frame is the same hardware turned: corners as round, borders as thin.
  expect((device?.frame.landscape.screenRadius ?? 0) * 874).toBeCloseTo(62, 5);
  expect((device?.frame.landscape.bezel.top ?? 0) * 874).toBeCloseTo(
    (device?.frame.portrait.bezel.left ?? 0) * 402,
    5,
  );
});

test("a channel that closed says so, and missing tools are a setup note", () => {
  const shown = phoneDevicesView({
    snapshot: {
      connected: false,
      inventoryLoaded: true,
      devices: [iphone],
      states: [],
      issues: [{ code: "tool_missing", message: "Device tools missing", hint: "Download them." }],
    },
    closed: true,
    threadId: "thread-1",
    deviceId: undefined,
    query: "",
    platform: "all",
    now: 0,
    agent: () => undefined,
    previous: new Map(),
  });

  expect(shown.offline?.message).toBe(
    "Lost the connection to this machine's simulators and emulators.",
  );
  expect(shown.toolsMissing).toBe(true);
  expect(shown.notes[0]?.message).toBe("A device tool is missing on this machine.");
  expect(shown.device).toBeNull();
});

test("a channel that never opened says it can't reach the devices instead of loading forever", () => {
  const input = {
    snapshot: { connected: false, inventoryLoaded: false, devices: [], states: [], issues: [] },
    closed: false,
    threadId: "thread-1",
    deviceId: undefined,
    query: "",
    platform: "all" as const,
    now: 0,
    agent: () => undefined,
    previous: new Map(),
  };
  // Still opening: the screen waits.
  expect(phoneDevicesView(input).offline).toBeNull();
  // The open ran out of time: one sentence, and no Reconnect needed since ace keeps trying.
  expect(phoneDevicesView({ ...input, unreachable: true }).offline).toEqual({
    message: "Can't reach this machine's simulators and emulators.",
    hint: "ace keeps trying.",
  });
});

test("a channel that opened but never answered its first reads says so instead of loading forever", () => {
  const input = {
    snapshot: { connected: true, inventoryLoaded: false, devices: [], states: [], issues: [] },
    closed: false,
    threadId: "thread-1",
    deviceId: undefined,
    query: "",
    platform: "all" as const,
    now: 0,
    agent: () => undefined,
    previous: new Map(),
  };
  expect(phoneDevicesView(input).offline).toBeNull();
  expect(phoneDevicesView({ ...input, unreachable: true }).offline).toEqual({
    message: "Can't read this machine's simulators and emulators.",
    hint: "ace keeps trying.",
  });
});

test("a machine that refuses this phone's device list says why instead of loading", () => {
  const refused = {
    message: "Administrator scope is required for device access",
    hint: "Pair again.",
  };
  const shown = phoneDevicesView({
    snapshot: {
      connected: true,
      inventoryLoaded: false,
      devices: [],
      states: [],
      issues: [],
    },
    closed: false,
    refused,
    threadId: "thread-1",
    deviceId: undefined,
    query: "",
    platform: "all",
    now: 0,
    agent: () => undefined,
    previous: new Map(),
  });

  expect(shown.offline).toEqual(refused);
  expect(view([], { refused }).offline).toBeNull();
});
