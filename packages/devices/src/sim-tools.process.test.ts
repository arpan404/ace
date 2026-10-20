import { expect, it, onTestFinished } from "vitest";
import { z } from "zod";
import { CredentialRegistry, ToolRegistry } from "@ace/mcp-server";
import { AgentId, ThreadId } from "@ace/protocol";
import { devicesToolkit } from "./index.ts";
import { fakeNode, fakeSimService } from "./testing/fake-sim.ts";

const ios = "ios:00000000-0000-4000-8000-00000000F00D";
const android = "android:Pixel_Fake";
type Node = { ref?: string | undefined; role: string; name: string; children: Node[] };
const Node: z.ZodType<Node> = z.lazy(() =>
  z.object({
    ref: z.string().optional(),
    role: z.string(),
    name: z.string(),
    children: z.array(Node),
  }),
);
const Tree = z.object({ nodes: z.array(Node) });

async function setup() {
  const fake = await fakeSimService();
  onTestFinished(() => fake.close());
  const registry = new ToolRegistry({ scheduler: { after: () => () => {} } });
  devicesToolkit(fake.service).register(registry);
  const credentials = new CredentialRegistry(() => "c".repeat(64));
  onTestFinished(() => credentials.close());
  const lease = credentials.issue(
    {
      sessionId: "sim-tools",
      threadId: ThreadId.parse("thread-1"),
      agentId: AgentId.parse("agent-1"),
      capabilities: ["devices"],
    },
    new AbortController().signal,
  );
  const raw = (name: string, args: Record<string, unknown> = {}) =>
    registry.call(name, args, lease.principal, new AbortController().signal);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await raw(name, args);
    const first = result.content[0];
    return {
      isError: result.isError === true,
      content: result.content,
      json: first?.type === "text" ? z.unknown().parse(JSON.parse(first.text)) : undefined,
    };
  };
  return { ...fake, call };
}
const flatten = (nodes: Node[]): Node[] =>
  nodes.flatMap((node) => [node, ...flatten(node.children)]);
const refOf = (tree: unknown, name: string) =>
  flatten(Tree.parse(tree).nodes).find((node) => node.name === name)?.ref;

const welcome = (ref = "p1") =>
  fakeNode(ref, "StaticText", "Welcome", { x: 0, y: 0, w: 300, h: 40 });
const continueButton = (ref = "p2") =>
  fakeNode(ref, "Button", "Continue", { x: 100, y: 500, w: 100, h: 40 }, ["press"]);

it("sim_ui gives actionable elements short refs, and tapping a ref presses that element", async () => {
  const h = await setup();
  h.platform.screens.set(ios, [welcome(), continueButton()]);
  expect((await h.call("sim_start", { simId: ios })).isError).toBe(false);
  const tree = (await h.call("sim_ui", { simId: ios })).json;
  expect(Tree.parse(tree).nodes).toEqual([
    { role: "StaticText", name: "Welcome", children: [] },
    { ref: "@e1", role: "Button", name: "Continue", children: [] },
  ]);
  const acted = await h.call("sim_act", { simId: ios, action: "tap", ref: "@e1" });
  expect(acted.json).toMatchObject({ ref: "@e1", role: "Button", name: "Continue" });
  expect(h.platform.effects).toEqual([`${ios} ui press Continue`]);
});

it("a ref keeps naming its element across reads, even when the platform renumbers its own ids", async () => {
  const h = await setup();
  h.platform.screens.set(ios, [welcome(), continueButton("p2")]);
  await h.call("sim_start", { simId: ios });
  expect(refOf((await h.call("sim_ui", { simId: ios })).json, "Continue")).toBe("@e1");
  const back = fakeNode("q1", "Button", "Back", { x: 0, y: 500, w: 80, h: 40 }, ["press"]);
  h.platform.screens.set(ios, [back, continueButton("q2")]);
  const reread = (await h.call("sim_ui", { simId: ios })).json;
  expect(refOf(reread, "Continue")).toBe("@e1");
  expect(refOf(reread, "Back")).toBe("@e2");
  await h.call("sim_act", { simId: ios, action: "ui", ref: "@e1", uiAction: "press" });
  expect(h.platform.effects).toEqual([`${ios} ui press Continue`]);
});

it("acting on a ref whose element has gone reports stale_ref and sends nothing", async () => {
  const h = await setup();
  h.platform.screens.set(ios, [welcome(), continueButton()]);
  await h.call("sim_start", { simId: ios });
  await h.call("sim_ui", { simId: ios });
  h.platform.screens.set(ios, [welcome("p9")]);
  const gone = await h.call("sim_act", { simId: ios, action: "tap", ref: "@e1" });
  expect(gone.isError).toBe(true);
  expect(gone.json).toMatchObject({
    code: "stale_ref",
    detail: expect.stringContaining('@e1 (Button "Continue") is no longer on screen'),
  });
  const unknown = await h.call("sim_act", { simId: ios, action: "tap", ref: "@e7" });
  expect(unknown.json).toMatchObject({ code: "stale_ref" });
  expect(h.platform.effects).toEqual([]);
});

it("typing into a ref focuses that element first; long_press holds its centre", async () => {
  const h = await setup();
  const field = fakeNode("f1", "android.widget.EditText", "Name", { x: 10, y: 20, w: 200, h: 60 }, [
    "press",
    "focus",
  ]);
  const label = fakeNode("l1", "android.widget.TextView", "Hint", { x: 10, y: 90, w: 200, h: 30 }, [
    "focus",
  ]);
  h.platform.screens.set(android, [field, label]);
  // The emulator is shut down: sim_start boots it.
  expect((await h.call("sim_start", { simId: android })).isError).toBe(false);
  await h.call("sim_ui", { simId: android });
  await h.call("sim_act", { simId: android, action: "type", ref: "@e1", text: "Ada" });
  await h.call("sim_act", { simId: android, action: "long_press", ref: "@e2", durationMs: 700 });
  // An element without press is tapped at its centre instead.
  await h.call("sim_act", { simId: android, action: "tap", ref: "@e2" });
  expect(h.platform.effects).toEqual([
    `${android} ui press Name`,
    `${android} input {"kind":"type","text":"Ada"}`,
    `${android} input {"kind":"longPress","x":110,"y":105,"durationMs":700}`,
    `${android} input {"kind":"tap","x":110,"y":105}`,
  ]);
  const refused = await h.call("sim_act", {
    simId: android,
    action: "ui",
    ref: "@e2",
    uiAction: "scroll",
  });
  expect(refused.json).toMatchObject({
    code: "not_supported",
    detail: expect.stringContaining("supports focus, not scroll"),
  });
});

it("a person taking the device refuses ref actions until it is handed back", async () => {
  const h = await setup();
  h.platform.screens.set(ios, [continueButton()]);
  await h.call("sim_start", { simId: ios });
  await h.call("sim_ui", { simId: ios });
  const person = { kind: "human" as const, owner: "person" };
  await h.service.request({ op: "controller", deviceId: ios, controller: "human" }, person);
  const refused = await h.call("sim_act", { simId: ios, action: "tap", ref: "@e1" });
  expect(refused.json).toMatchObject({ code: "lease_required" });
  expect(h.platform.effects).toEqual([]);
  await h.service.request({ op: "controller", deviceId: ios, controller: "none" }, person);
  await h.call("sim_start", { simId: ios });
  await h.call("sim_act", { simId: ios, action: "tap", ref: "@e1" });
  expect(h.platform.effects).toEqual([`${ios} ui press Continue`]);
});

it("the device how-to arrives with an agent's first start of a device, and only then", async () => {
  const h = await setup();
  const listed = await h.call("sim_list");
  expect(JSON.stringify(listed.json)).not.toContain("Refs first");
  const first = await h.call("sim_start", { simId: ios });
  expect(first.json).toMatchObject({
    simId: ios,
    controller: "agent",
    guide: expect.stringContaining("Refs first"),
  });
  expect(first.json).toMatchObject({
    guide: expect.stringContaining(`ace sim <verb> ${ios} --thread thread-1`),
  });
  const again = await h.call("sim_start", { simId: ios });
  expect(again.json).not.toHaveProperty("guide");
});

it("sim_screenshot reads the live view while it runs, and takes a one-off frame once it stops", async () => {
  const h = await setup();
  await h.call("sim_start", { simId: ios });
  const live = await h.call("sim_screenshot", { simId: ios });
  expect(live.content[0]).toMatchObject({
    type: "image",
    data: Buffer.from("live-0").toString("base64"),
  });
  expect(h.platform.shots).toEqual([]);
  await h.call("sim_stop", { simId: ios });
  const still = await h.call("sim_screenshot", { simId: ios });
  expect(still.isError).toBe(false);
  const image = still.content[0];
  if (image?.type !== "image") throw new Error("Expected an image");
  // A real JPEG of the device's screen, with its scale for sim_act points.
  expect(Buffer.from(image.data, "base64").subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
  expect(still.content[1]).toMatchObject({ text: expect.stringContaining("300x600") });
  expect(h.platform.shots).toEqual([ios]);
});

it("the clipboard round-trips through sim_act and is refused while a person holds the device", async () => {
  const h = await setup();
  await h.call("sim_start", { simId: ios });
  const set = await h.call("sim_act", { simId: ios, action: "clipboard_set", text: "héllo 👋" });
  expect(set.isError).toBe(false);
  expect((await h.call("sim_act", { simId: ios, action: "clipboard_get" })).json).toEqual({
    text: "héllo 👋",
    truncated: false,
  });
  // A clipboard longer than the budget comes back cut, and says so.
  h.platform.clipboards.set(ios, "x".repeat(5000));
  expect((await h.call("sim_act", { simId: ios, action: "clipboard_get" })).json).toEqual({
    text: "x".repeat(4096),
    truncated: true,
  });
  const missing = await h.call("sim_act", { simId: ios, action: "clipboard_set" });
  expect(missing.isError).toBe(true);
  const person = { kind: "human" as const, owner: "person" };
  await h.service.request({ op: "controller", deviceId: ios, controller: "human" }, person);
  const held = await h.call("sim_act", { simId: ios, action: "clipboard_get" });
  expect(held.json).toMatchObject({ code: "lease_required" });
  expect(h.platform.effects).toEqual([`${ios} clipboard "héllo 👋"`]);
});

it("recents reaches an Android emulator and is refused on iOS with a way forward", async () => {
  const h = await setup();
  await h.call("sim_start", { simId: android });
  await h.call("sim_act", { simId: android, action: "key", key: "recents" });
  await h.call("sim_start", { simId: ios });
  const refused = await h.call("sim_act", { simId: ios, action: "key", key: "recents" });
  expect(refused.json).toMatchObject({
    code: "not_supported",
    detail: expect.stringContaining("no Recents key"),
  });
  expect(h.platform.effects).toEqual([`${android} input {"kind":"key","key":"recents"}`]);
});
