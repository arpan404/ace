import { DeviceClient } from "@ace/client/devices";
import { ScreenUITreeResult, type ScreenUINode } from "@ace/protocol";
import { expect, it, onTestFinished } from "vitest";
import { FakeAppDevices } from "./app-devices.ts";

/** Let the fake answer: its replies arrive a few microtasks after a request. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const iphone = "ios:7d1b2c4e-5a6f-4e8d-9b0a-1c2d3e4f5a6b";

async function connected() {
  const fake = new FakeAppDevices(() => 1000);
  let id = 0;
  const client = new DeviceClient({ id: () => `device-${++id}`, schedule: () => () => {} });
  onTestFinished(() => client.disconnect());
  client.connect(fake.transport());
  await settle();
  await client.request({ op: "enable", enabled: true });
  await client.request({ op: "list" });
  return { fake, client };
}
const flat = (nodes: ScreenUINode[]): ScreenUINode[] =>
  nodes.flatMap((node) => [node, ...flat(node.children)]);
const stateOf = (client: DeviceClient, deviceId: string) =>
  client.getSnapshot().states.find((state) => state.device.id === deviceId);

it("a viewer sees the agent that took a device and each action it takes, numbered in order", async () => {
  const { fake, client } = await connected();
  fake.agentTakes(iphone, "thread-1", "agent-1");
  await settle();
  expect(stateOf(client, iphone)).toMatchObject({
    controller: "agent",
    threadId: "thread-1",
    holder: { threadId: "thread-1", agentId: "agent-1" },
  });
  expect(stateOf(client, iphone)?.activity).toBeUndefined();

  fake.agentActs(iphone, { action: "tap", ref: "e7", label: "Sign in", point: { x: 195, y: 244 } });
  fake.agentActs(iphone, { action: "type" });
  await settle();
  expect(stateOf(client, iphone)?.activity).toEqual({ sequence: 2, action: "type" });
  // Agent actions are not a person's inputs.
  expect(fake.inputs).toEqual([]);
});

it("a device added to the inventory reaches open viewers alongside the defaults", async () => {
  const { fake, client } = await connected();
  fake.addDevice({
    id: "ios:11111111-2222-4333-8444-555555555555",
    platform: "ios",
    name: "iPad Pro 13-inch",
    state: "shutdown",
  });
  await settle();
  expect(client.getSnapshot().devices.map((device) => device.name)).toEqual([
    "iPhone 16 Pro",
    "Pixel 9",
    "iPad Pro 13-inch",
  ]);
});

it("a device's accessibility tree names its elements by ref, inside the screen", async () => {
  const { client } = await connected();
  const tree = ScreenUITreeResult.parse(
    await client.request({ op: "ui.tree", deviceId: iphone, maxDepth: 8, maxNodes: 200 }),
  );
  const nodes = flat(tree.nodes);
  expect(nodes.find((node) => node.ref === "e7")).toMatchObject({
    role: "Button",
    name: "Sign in",
  });
  for (const { bounds } of nodes) {
    expect(bounds.x + bounds.w).toBeLessThanOrEqual(390);
    expect(bounds.y + bounds.h).toBeLessThanOrEqual(844);
  }
});
