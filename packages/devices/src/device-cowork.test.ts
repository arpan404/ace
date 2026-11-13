import { expect, it, onTestFinished } from "vitest";
import { agentOwner, callSimTool, DevicePlatform, DevicesService, type Actor } from "./index.ts";

const deviceId = "android:Pixel";
const person: Actor = { kind: "human", owner: "phone-1" };
const agent: Actor = {
  kind: "agent",
  threadId: "thread-1",
  agentId: "agent-1",
  owner: agentOwner("thread-1", "agent-1"),
};
const tap = (x: number) => ({ op: "input", deviceId, input: { kind: "tap", x, y: 10 } }) as const;

const tick = () => new Promise((resolve) => setTimeout(resolve, 1));

/** A cowork devices service over a scripted platform, with a clock the test moves. */
async function fixture() {
  let now = 1_000;
  let timers: { at: number; run: () => void }[] = [];
  const platform = new DevicePlatform({ platform: "linux", home: "/unused", env: {} });
  platform.list = async () => [
    { id: deviceId, name: "Pixel", platform: "android", state: "booted" },
  ];
  const taps: string[] = [];
  const held = new Map<number, Promise<void>>();
  // The SDK input boundary stands in for a native device unavailable to unit tests.
  platform.input = async (_device, input, _binding, guard) => {
    guard?.();
    if (input.kind === "tap") {
      taps.push(String(input.x));
      await held.get(input.x);
    }
  };
  const service = new DevicesService({
    platform,
    env: {},
    recordingDirectory: "/unused",
    publishArtifact: async () => {},
    runtime: {
      now: () => now,
      id: () => "unused",
      after(ms, run) {
        const timer = { at: now + ms, run };
        timers.push(timer);
        return () => {
          timers = timers.filter((each) => each !== timer);
        };
      },
      spawn() {
        throw new Error("Unexpected native capture");
      },
    },
  });
  onTestFinished(() => service.close());
  await service.request({ op: "enable", enabled: true }, person);
  await service.claimForAgent(deviceId, agent);
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      await tick();
      const due = timers.filter((timer) => timer.at <= end).toSorted((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((timer) => timer !== due);
      now = due.at;
      due.run();
    }
    now = end;
    await tick();
  };
  const state = () => service.states().find((each) => each.device.id === deviceId);
  const holdTap = (x: number) => {
    const gate = Promise.withResolvers<void>();
    held.set(x, gate.promise);
    onTestFinished(() => gate.resolve());
    return () => gate.resolve();
  };
  platform.clipboardRead = async (_device, guard) => {
    guard?.();
    return { text: "shared clipboard", truncated: false };
  };
  return { service, taps, advance, state, holdTap };
}

it("the person's tap goes into a device an agent holds, and the agent's tap waits until they pause", async () => {
  const { service, taps, advance, state } = await fixture();
  await service.request(tap(1), person);
  expect(taps).toEqual(["1"]);
  expect(state()).toMatchObject({ controller: "agent", sharing: "cowork", personActive: true });
  let done = false;
  const agentTap = service.request(tap(2), agent).then(() => (done = true));
  await tick();
  await advance(2_000);
  await service.request(tap(3), person);
  await advance(2_900);
  expect(done).toBe(false);
  expect(taps).toEqual(["1", "3"]);
  await advance(200);
  await agentTap;
  expect(taps).toEqual(["1", "3", "2"]);
  expect(state()?.personActive).toBeUndefined();
});

it("after a minute of the person's input the agent's tap gives up with person_busy and is never sent", async () => {
  const { service, taps, advance } = await fixture();
  await service.request(tap(1), person);
  const agentTap = service.request(tap(2), agent);
  const refused = expect(agentTap).rejects.toMatchObject({ code: "person_busy" });
  for (let second = 0; second < 61; second++) {
    await advance(1_000);
    await service.request(tap(1), person);
  }
  await refused;
  expect(taps).not.toContain("2");
});

it("a person's Take control is exclusive: the agent is refused as before", async () => {
  const { service, state } = await fixture();
  await service.request({ op: "controller", deviceId, controller: "human" }, person);
  expect(state()).toMatchObject({ controller: "human", sharing: "exclusive" });
  await expect(service.request(tap(2), agent)).rejects.toMatchObject({ code: "lease_required" });
});

it("an agent's action is the pointer device views draw", async () => {
  const { service, state } = await fixture();
  service.noteAgentActivity(deviceId, {
    action: "swipe",
    point: { x: 5, y: 6 },
    to: { x: 50, y: 60 },
  });
  expect(state()?.agentPointer).toEqual({ x: 50, y: 60, kind: "drag", at: 1_000 });
});

it("a queued agent yields when the person returns without holding up their input", async () => {
  const { service, taps, advance, holdTap } = await fixture();
  const release = holdTap(90);
  const running = service.request(tap(90), agent);
  await tick();
  const queued = service.request(tap(2), agent);
  await tick();
  const human = service.request(tap(1), person);
  await tick();
  release();
  await running;
  await human;
  expect(taps).toEqual(["90", "1"]);
  await advance(2_999);
  expect(taps).toEqual(["90", "1"]);
  await advance(1);
  await queued;
  expect(taps).toEqual(["90", "1", "2"]);
});

it("shared human input queued before another person's takeover is refused", async () => {
  const { service, taps, holdTap } = await fixture();
  const release = holdTap(90);
  const running = service.request(tap(90), agent);
  const revoked = expect(running).rejects.toMatchObject({ code: "lease_required" });
  await tick();
  const shared = service.request(tap(1), person);
  const refused = expect(shared).rejects.toMatchObject({ code: "lease_required" });
  await tick();
  const other: Actor = { kind: "human", owner: "phone-2" };
  await service.request({ op: "controller", deviceId, controller: "human" }, other);
  release();
  await revoked;
  await refused;
  await service.request(tap(3), other);
  expect(taps).toEqual(["90", "3"]);
});

it("an agent's controller ticket survives more than thirty seconds waiting for the person", async () => {
  const { service, taps, advance, state } = await fixture();
  await service.request(tap(1), person);
  // Exercise sim_act too: its wait must happen inside the retained input request.
  const pending = callSimTool(
    service,
    "sim_act",
    { simId: deviceId, action: "tap", x: 2, y: 10 },
    { ...agent, kind: "agent", threadId: "thread-1", agentId: "agent-1" },
    new AbortController().signal,
  );
  await tick();
  for (let second = 0; second < 35; second++) {
    await advance(1_000);
    await service.request(tap(1), person);
  }
  expect(state()?.controller).toBe("agent");
  expect(taps).not.toContain("2");
  await advance(3_000);
  expect(await pending).toMatchObject({
    kind: "json",
    value: { waited: "Waited 38 s while the person used Pixel." },
  });
  expect(taps.at(-1)).toBe("2");
  expect(state()?.controller).toBe("agent");
});

it("a dequeue retry keeps the original minute deadline and leaves human input unblocked", async () => {
  const { service, taps, advance, holdTap } = await fixture();
  await service.request(tap(1), person);
  const pending = service.request(tap(2), agent);
  let code: string | undefined;
  const refused = pending.catch((error: unknown) => {
    if (error instanceof Error && "code" in error && typeof error.code === "string")
      code = error.code;
  });
  await tick();
  for (let second = 0; second < 20; second++) {
    await advance(1_000);
    await service.request(tap(1), person);
  }
  const release = holdTap(90);
  const running = service.request(tap(90), person);
  await tick();
  // The lease lapses while this human action is still executing: the agent queues behind it.
  await advance(3_000);
  await advance(1_000);
  const human = service.request(tap(1), person);
  await tick();
  release();
  await running;
  await human;
  for (let second = 24; second < 60; second++) {
    await advance(1_000);
    await service.request(tap(1), person);
  }
  expect(code).toBe("person_busy");
  await refused;
  expect(taps).not.toContain("2");
});

it("a takeover invalidates an agent ticket retained while waiting for the person", async () => {
  const { service, taps, advance } = await fixture();
  await service.request(tap(1), person);
  const pending = service.request(tap(2), agent);
  const refused = expect(pending).rejects.toMatchObject({ code: "lease_required" });
  await tick();
  await service.request({ op: "controller", deviceId, controller: "human" }, person);
  await advance(3_000);
  await refused;
  expect(taps).toEqual(["1"]);
});

it("a simulator clipboard read does not wait for the person's lease or queued input", async () => {
  const { service, holdTap } = await fixture();
  const release = holdTap(90);
  const running = service.request(tap(90), person);
  await tick();
  const result = await callSimTool(
    service,
    "sim_act",
    { simId: deviceId, action: "clipboard_get" },
    { ...agent, kind: "agent", threadId: "thread-1", agentId: "agent-1" },
    new AbortController().signal,
  );
  expect(result).toEqual({ kind: "json", value: { text: "shared clipboard", truncated: false } });
  release();
  await running;
});

it("thirty-two waiting agents leave a separately bounded lane for human input", async () => {
  const { service, taps, advance, holdTap } = await fixture();
  await service.request(tap(1), person);
  const agents = Array.from({ length: 32 }, () => service.request(tap(2), agent));
  await tick();
  await expect(service.request(tap(3), agent)).rejects.toMatchObject({ code: "busy" });
  // Even with every agent slot occupied, the person's input reaches the device.
  await service.request(tap(4), person);
  expect(taps).toEqual(["1", "4"]);
  const release = holdTap(90);
  const humans = [service.request(tap(90), person)];
  await tick();
  for (let index = 1; index < 32; index++) humans.push(service.request(tap(5), person));
  await tick();
  await expect(service.request(tap(6), person)).rejects.toMatchObject({ code: "busy" });
  release();
  await Promise.all(humans);
  expect(taps.filter((value) => value === "5")).toHaveLength(31);
  expect(taps).not.toContain("2");
  expect(taps).not.toContain("3");
  expect(taps).not.toContain("6");
  await advance(3_000);
  await Promise.all(agents);
  expect(taps.filter((value) => value === "2")).toHaveLength(32);
  // Completion frees each lane's admission slots for later requests.
  await service.request(tap(7), agent);
  await service.request(tap(8), person);
  expect(taps.slice(-2)).toEqual(["7", "8"]);
});
