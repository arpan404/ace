import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { MachineSummary, MachineToolResult, ProviderKind } from "@ace/protocol";
import { fakeNode, fakeSimService } from "@ace/devices/testing";
import { invoke } from "../browser-mcp-test-support.ts";
import { pairedMachines } from "./machine-test-support.ts";
import { callAs, fleetWindow, secondMachine, sourceProfile } from "./grants-test-support.ts";

const ios = "ios:00000000-0000-4000-8000-00000000F00D";
const android = "android:Pixel_Fake";
const person = { kind: "human" as const, owner: "person" };
const Machines = z.object({ machines: z.array(MachineSummary) });
const McpResult = z.object({
  result: z.object({
    content: z.array(
      z.union([
        z.object({ type: z.literal("text"), text: z.string() }),
        z.object({ type: z.literal("image"), data: z.string(), mimeType: z.string() }),
      ]),
    ),
    isError: z.boolean().optional(),
  }),
});

const fakes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of fakes.splice(0)) await close();
});

/** A Mac lending its simulators (fake ones) to a linked Linux box with nothing installed. */
async function lending() {
  const fake = await fakeSimService();
  fakes.push(() => fake.close());
  const pair = await pairedMachines({ access: "operate", targetDevices: fake.service });
  for (const provider of ProviderKind.options)
    if (pair.target.h.registry.has(provider))
      pair.target.h.registry.get(provider).discovery.installed = false;
  await pair.source.daemon.settings.set("host.displayName", "Linux box", { kind: "global" });
  return { pair, fake, window: await fleetWindow(pair.target) };
}

/** The Linux box's own agent calling sim_* tools over MCP, as its provider would. */
function linuxAgent(pair: Awaited<ReturnType<typeof pairedMachines>>) {
  const { threadId, agentId } = pair.source.caller;
  const lease = pair.source.daemon.mcp.openSession(
    { sessionId: "linux-agent", threadId, agentId, capabilities: ["devices"] },
    new AbortController().signal,
  );
  const connection = { url: pair.source.daemon.mcp.url, bearer: lease.bearer };
  return async (name: string, args: Record<string, unknown>) =>
    McpResult.parse(await (await invoke(connection, name, args)).json()).result;
}
const text = (result: { content: { type: string; text?: string }[] }) =>
  result.content.flatMap((part) => (part.text === undefined ? [] : [part.text])).join("\n");
/** What the target's devices say about one device: who holds it, from which thread. */
const stateOf = (fake: Awaited<ReturnType<typeof fakeSimService>>, id: string) =>
  fake.service.states().find((state) => state.device.id === id);

it("an agent on another machine lists, starts, drives and screenshots a simulator there", async () => {
  const { pair, fake, window } = await lending();
  const studio = Machines.parse((await pair.source.call({ op: "machines" })).data).machines[0];
  expect(studio).toMatchObject({ providers: [], tools: expect.arrayContaining(["devices"]) });

  const sim = linuxAgent(pair);
  const listed = await sim("sim_list", { machine: "studio" });
  expect(listed.isError, text(listed)).not.toBe(true);
  expect(text(listed)).toContain(android);

  const started = await sim("sim_start", { simId: ios, machine: "studio" });
  expect(started.isError, text(started)).not.toBe(true);
  const guide = z
    .object({ controller: z.string(), guide: z.string() })
    .parse(JSON.parse(text(started)));
  expect(guide.controller).toBe("agent");
  // Its how-to tells it to keep naming the machine, not a shell on a machine it isn't on.
  expect(guide.guide).toContain("pass the same machine");
  expect(guide.guide).not.toContain("ace sim");

  // The Mac shows who holds it: a guest session named for the Linux box and its thread.
  const holder = stateOf(fake, ios)?.holder;
  if (!holder) throw new Error("No holder on the Mac");
  expect(pair.target.daemon.store.getThread(holder.threadId)).toMatchObject({
    title: expect.stringMatching(/^Linux box · /),
    details: { guest: { name: "Linux box" } },
  });

  fake.platform.screens.set(ios, [
    fakeNode("p-continue", "Button", "Continue", { x: 10, y: 500, w: 100, h: 40 }, ["press"]),
  ]);
  const read = await sim("sim_ui", { simId: ios, machine: "studio" });
  expect(text(read)).toContain('"ref":"@e1"');
  const tapped = await sim("sim_act", { simId: ios, action: "tap", ref: "@e1", machine: "studio" });
  expect(tapped.isError, text(tapped)).not.toBe(true);
  expect(fake.platform.effects).toEqual([`${ios} ui press Continue`]);

  const shot = await sim("sim_screenshot", { simId: ios, machine: "studio" });
  const image = shot.content.find((part) => part.type === "image");
  expect(image).toMatchObject({ mimeType: "image/jpeg" });
  expect(Buffer.from(image && "data" in image ? image.data : "", "base64").length).toBeGreaterThan(
    0,
  );
  expect(text(shot)).toContain("scale");
  await window.close();
});

it("Simulators read only lets agents look but not act; off frees the device at once", async () => {
  const { pair, fake, window } = await lending();
  const laptop = sourceProfile(pair);
  const from = { host: "linux-box", thread: "fix-login" };
  const start = { op: "devices", tool: "sim_start", args: { simId: ios } } as const;
  expect(await callAs(laptop, start, from)).toMatchObject({ ok: true });
  expect(stateOf(fake, ios)?.controller).toBe("agent");
  // The Linux box's own agents see the Mac's simulators too.
  await pair.source.call({ op: "machines" });

  await window.set(laptop.deviceId, "devices", "read");
  // Read only can't drive a device, so it holds none: the lease is gone, the binding stays.
  await vi.waitFor(() => expect(stateOf(fake, ios)?.controller).toBe("none"));
  const look = { op: "devices", tool: "sim_screenshot", args: { simId: ios } } as const;
  const shot = await callAs(laptop, look, from);
  if (!shot.ok) throw new Error(shot.message);
  expect(MachineToolResult.parse(shot.body).content[0]).toMatchObject({ type: "image" });
  expect(await callAs(laptop, { op: "devices", tool: "sim_list", args: {} }, from)).toMatchObject({
    ok: true,
  });
  const home = {
    op: "devices",
    tool: "sim_act",
    args: { simId: ios, action: "key", key: "home" },
  } as const;
  expect(await callAs(laptop, home, from)).toMatchObject({
    ok: false,
    code: "machine_forbidden",
  });
  expect(await callAs(laptop, start, from)).toMatchObject({ ok: false, code: "machine_forbidden" });
  expect(fake.platform.effects).toEqual([]);

  // Back to act, it takes the device again; turned off, the device is free with no call running.
  await window.set(laptop.deviceId, "devices", "operate");
  expect(await callAs(laptop, start, from)).toMatchObject({ ok: true });
  expect(stateOf(fake, ios)?.controller).toBe("agent");
  await window.set(laptop.deviceId, "devices", "off");
  await vi.waitFor(() => expect(stateOf(fake, ios)?.controller).toBe("none"));
  expect(await callAs(laptop, look, from)).toMatchObject({
    ok: false,
    code: "machine_forbidden",
    message: expect.stringContaining("off"),
  });

  // The calling agent hears it as a refusal with a next step, never a silent failure.
  const refused = await linuxAgent(pair)("sim_list", { machine: "studio" });
  expect(refused.isError).toBe(true);
  expect(text(refused)).toContain("machine_forbidden");
  await window.close();
});

const startOn = (simId: string) => ({ op: "devices", tool: "sim_start", args: { simId } }) as const;
const pressHome = (simId: string) =>
  ({ op: "devices", tool: "sim_act", args: { simId, action: "key", key: "home" } }) as const;

it("agents from two machines drive two simulators at once, and never share one", async () => {
  const { pair, fake, window } = await lending();
  const laptop = sourceProfile(pair);
  const build = await secondMachine(pair);
  const linux = { host: "linux-box", thread: "fix-login" };
  const server = { host: "build-server", thread: "build-thread" };

  const [first, second] = await Promise.all([
    callAs(laptop, startOn(ios), linux),
    callAs(build, startOn(android), server),
  ]);
  expect(first, JSON.stringify(first)).toMatchObject({ ok: true });
  expect(second, JSON.stringify(second)).toMatchObject({ ok: true });
  const iosHolder = stateOf(fake, ios)?.holder?.threadId;
  const androidHolder = stateOf(fake, android)?.holder?.threadId;
  expect(iosHolder).toBeDefined();
  expect(androidHolder).toBeDefined();
  expect(iosHolder).not.toBe(androidHolder);

  // Both act on their own device in parallel.
  const acted = await Promise.all([
    callAs(laptop, pressHome(ios), linux),
    callAs(build, pressHome(android), server),
  ]);
  expect(acted).toEqual([
    expect.objectContaining({ ok: true }),
    expect.objectContaining({ ok: true }),
  ]);
  expect(fake.platform.effects).toHaveLength(2);

  // The build server can't take the Linux box's simulator, and is told whose it is.
  const taken = await callAs(build, startOn(ios), server);
  if (!taken.ok) throw new Error(taken.message);
  const result = MachineToolResult.parse(taken.body);
  expect(result.isError).toBe(true);
  expect(text(result)).toContain('"code":"busy"');
  expect(text(result)).toContain("An agent from linux-box holds");
  expect(stateOf(fake, ios)?.holder?.threadId).toBe(iosHolder);
  await window.close();
});

it("a person taking a simulator on that machine stops the remote agent", async () => {
  const { pair, fake, window } = await lending();
  const sim = linuxAgent(pair);
  await pair.source.call({ op: "machines" });
  expect((await sim("sim_start", { simId: ios, machine: "studio" })).isError).not.toBe(true);

  await fake.service.request({ op: "controller", deviceId: ios, controller: "human" }, person);
  const act = await sim("sim_act", { simId: ios, action: "key", key: "home", machine: "studio" });
  expect(act.isError).toBe(true);
  expect(text(act)).toContain("lease_required");
  const again = await sim("sim_start", { simId: ios, machine: "studio" });
  expect(again.isError).toBe(true);
  expect(text(again)).toContain("lease_required");
  expect(fake.platform.effects).toEqual([]);
  expect(stateOf(fake, ios)?.controller).toBe("human");
  await window.close();
});
