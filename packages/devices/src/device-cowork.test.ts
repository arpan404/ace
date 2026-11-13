import { expect, it, onTestFinished } from "vitest";
import { agentOwner, DevicePlatform, DevicesService, type Actor } from "./index.ts";

const deviceId = "android:Pixel";
const person: Actor = { kind: "human", owner: "phone-1" };
const agent: Actor = {
  kind: "agent",
  threadId: "thread-1",
  agentId: "agent-1",
  owner: agentOwner("thread-1", "agent-1"),
};
const tap = (x: number) => ({ op: "input", deviceId, input: { kind: "tap", x, y: 10 } }) as const;

/** A cowork devices service over a scripted platform, with a clock the test moves. */
async function fixture() {
  let now = 1_000;
  let timers: { at: number; run: () => void }[] = [];
  const platform = new DevicePlatform({ platform: "linux", home: "/unused", env: {} });
  platform.list = async () => [
    { id: deviceId, name: "Pixel", platform: "android", state: "booted" },
  ];
  const taps: string[] = [];
  // The SDK input boundary stands in for a native device unavailable to unit tests.
  platform.input = async (_device, input, _binding, guard) => {
    guard?.();
    if (input.kind === "tap") taps.push(String(input.x));
  };
  const service = new DevicesService({
    platform,
    env: {},
    recordingDirectory: "/unused",
    publishArtifact: async () => {},
    cowork: true,
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
  const tick = () => new Promise((resolve) => setTimeout(resolve, 1));
  const advance = async (ms: number) => {
    const end = now + ms;
    for (;;) {
      await tick();
      const due = timers.filter((timer) => timer.at <= end).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      timers = timers.filter((timer) => timer !== due);
      now = due.at;
      due.run();
    }
    now = end;
    await tick();
  };
  const state = () => service.states().find((each) => each.device.id === deviceId);
  return { service, taps, advance, tick, state };
}

it("the person's tap goes into a device an agent holds, and the agent's tap waits until they pause", async () => {
  const { service, taps, advance, tick, state } = await fixture();
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
