import { expect, it, vi } from "vitest";
import { z } from "zod";
import { MachineSummary, MachineToolResult, ProviderKind, type ThreadId } from "@ace/protocol";
import { invoke } from "../browser-mcp-test-support.ts";
import { pairedMachines } from "./machine-test-support.ts";
import { callAs, fleetWindow, sourceProfile } from "./grants-test-support.ts";
import { computerUse } from "./screen-test-support.ts";

const Machines = z.object({ machines: z.array(MachineSummary) });
const ToolReply = z.object({
  result: z.object({
    isError: z.boolean().optional(),
    content: z.array(z.object({ type: z.string(), text: z.string().optional() })),
  }),
});
const look = { op: "screen", tool: "screen_state", args: { app: "Calculator" } } as const;
const press = {
  op: "screen",
  tool: "screen_act",
  args: { app: "Calculator", actions: [{ type: "type", text: "408" }] },
} as const;
/** An action that keeps the other machine busy until it is stopped. */
const linger = {
  op: "screen",
  tool: "screen_act",
  args: {
    app: "Calculator",
    actions: [
      { type: "wait", ms: 10_000 },
      { type: "wait", ms: 10_000 },
    ],
  },
} as const;

const textOf = (body: unknown) =>
  MachineToolResult.parse(body)
    .content.flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join("\n");

/** The target's guest session for a calling thread, once a call made it. */
function guestThread(pair: Awaited<ReturnType<typeof pairedMachines>>, host: string): ThreadId {
  const thread = pair.target.daemon.store
    .listThreads()
    .find((entry) => entry.details?.guest?.host === host);
  if (!thread) throw new Error("No guest session yet");
  return thread.id;
}

it("a linked machine uses this machine's apps only as far as the person allows, with no provider here", async () => {
  const mac = await computerUse();
  const pair = await pairedMachines({ access: "operate", targetScreen: mac });
  await mac.screen.enable(true);
  // Nothing is installed on the target: no CLI an agent could run in.
  const { registry } = pair.target.h;
  for (const provider of ProviderKind.options)
    if (registry.has(provider)) registry.get(provider).discovery.installed = false;
  const window = await fleetWindow(pair.target);
  const laptop = sourceProfile(pair);
  const from = { host: "linux-box", thread: "fix-login" };

  // Off until the person allows it, with where to do that.
  expect(await callAs(laptop, look, from)).toMatchObject({
    ok: false,
    code: "machine_forbidden",
    message: expect.stringMatching(/Computer use is off.*Settings › Fleet/),
  });

  // Read only: looking works, with the picture; acting doesn't.
  await window.set(laptop.deviceId, "screen", "read");
  const looked = await callAs(
    laptop,
    { ...look, args: { ...look.args, screenshot: true } },
    from,
  );
  if (!looked.ok) throw new Error(looked.message);
  expect(textOf(looked.body)).toContain("Calculator");
  expect(MachineToolResult.parse(looked.body).content).toContainEqual(
    expect.objectContaining({ type: "image", mimeType: "image/jpeg" }),
  );
  const apps = await callAs(laptop, { op: "screen", tool: "screen_apps", args: {} }, from);
  if (!apps.ok) throw new Error(apps.message);
  expect(textOf(apps.body)).toContain("Calculator (com.apple.calculator)");
  expect(await callAs(laptop, press, from)).toMatchObject({
    ok: false,
    code: "machine_forbidden",
    message: expect.stringContaining("only read"),
  });

  // Read and act: it types into the app.
  await window.set(laptop.deviceId, "screen", "operate");
  const pressed = await callAs(laptop, press, from);
  if (!pressed.ok) throw new Error(pressed.message);
  expect(textOf(pressed.body)).toContain("typed 3 characters");
  // The work ran in a guest session named for the calling machine and thread.
  expect(pair.target.daemon.store.getThread(guestThread(pair, "linux-box"))?.title).toBe(
    "linux-box · Check the release",
  );

  // This machine's own computer-use switch still decides, whatever the grant says.
  await mac.screen.enable(false);
  expect(await callAs(laptop, look, from)).toMatchObject({
    ok: false,
    code: "unavailable",
    message: expect.stringContaining("Settings › Computer use"),
  });
  const [studio] = Machines.parse((await pair.source.call({ op: "machines" })).data).machines;
  expect(studio?.tools).not.toContain("screen");
  await window.close();
});

it("an agent here uses the other machine's apps with machine, and a request there is answered here", async () => {
  const mac = await computerUse();
  const linux = await computerUse();
  const pair = await pairedMachines({ access: "operate", targetScreen: mac, sourceScreen: linux });
  await mac.screen.enable(true);
  await linux.screen.enable(true);
  const window = await fleetWindow(pair.target);
  await window.set(sourceProfile(pair).deviceId, "screen", "operate");
  await pair.source.call({ op: "machines" });
  const { threadId, agentId } = pair.source.caller;
  const lease = pair.source.daemon.mcp.openSession(
    { sessionId: "computer-across", threadId, agentId, capabilities: ["screen"] },
    new AbortController().signal,
  );
  const connection = { url: pair.source.daemon.mcp.url, bearer: lease.bearer };

  const acting = invoke(connection, "screen_act", {
    app: "Calculator",
    actions: [
      { type: "wait", ms: 4_000 },
      { type: "type", text: "408" },
    ],
    machine: "studio",
  }).then(async (response) => ToolReply.parse(await response.json()).result);
  // While it runs, the target asks the person something in that session.
  let guest: ThreadId | undefined;
  await vi.waitFor(() => {
    guest = pair.target.daemon.store
      .listThreads()
      .find((entry) => entry.details?.guest !== undefined)?.id;
    if (!guest || pair.target.daemon.store.getThread(guest)?.status.state !== "waiting")
      throw new Error("The action is not running there yet");
  });
  if (!guest) throw new Error("No guest session");
  const engine = pair.target.daemon.engine;
  if (!engine) throw new Error("Engine unavailable");
  const key = "screen-check:1";
  const asked = engine.openHostApproval(
    guest,
    key,
    {
      kind: "approval",
      title: "Let it keep typing in Calculator?",
      options: [{ id: "allow_once", label: "Allow once", kind: "allow_once" }],
    },
    [],
  );
  const session = guest;
  engine.bindHostInteractions((command) => {
    if (command.payload.type !== "interaction.resolve" || command.payload.interactionId !== asked)
      return undefined;
    engine.resolveHostApproval(session, key, {
      state: "resolved",
      resolution: command.payload.resolution,
    });
    return { commandId: command.id, ok: true };
  });

  // It shows in the calling thread, titled with the machine, and is answered there.
  const mirrored = await pair.requestIn(
    pair.source,
    threadId,
    (interaction) =>
      interaction.request.kind === "approval" &&
      interaction.request.title === "Studio: Let it keep typing in Calculator?",
  );
  await pair.answer(mirrored, "allow_once");
  await vi.waitFor(
    () =>
      expect(pair.target.daemon.store.getInteraction(asked)).toMatchObject({
        state: "resolved",
        resolution: { kind: "approval", optionId: "allow_once" },
      }),
    { timeout: 10_000 },
  );

  const result = await acting;
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  expect(result.content[0]?.text).toContain("typed 3 characters");
  await window.close();
});

it("turning computer use down stops that machine's action at once and forgets what it saw", async () => {
  const mac = await computerUse();
  const pair = await pairedMachines({ access: "operate", targetScreen: mac });
  await mac.screen.enable(true);
  const window = await fleetWindow(pair.target);
  const laptop = sourceProfile(pair);
  const from = { host: "linux-box", thread: "long-task" };
  await window.set(laptop.deviceId, "screen", "operate");

  // A second look returns only what changed since the agent's first one.
  expect(await callAs(laptop, look, from)).toMatchObject({ ok: true });
  const again = await callAs(laptop, look, from);
  if (!again.ok) throw new Error(again.message);
  expect(textOf(again.body)).toContain("No change since your last look.");

  const started = Date.now();
  const waiting = callAs(laptop, linger, from);
  await vi.waitFor(
    () =>
      expect(pair.target.daemon.store.getThread(guestThread(pair, "linux-box"))?.status.state).toBe(
        "waiting",
      ),
    { timeout: 10_000 },
  );
  await window.set(laptop.deviceId, "screen", "read");
  expect(await waiting).toMatchObject({
    ok: false,
    code: "machine_forbidden",
    message: expect.stringContaining("turned this off"),
  });
  expect(Date.now() - started).toBeLessThan(15_000);
  await vi.waitFor(
    () =>
      expect(
        pair.target.daemon.store.getThread(guestThread(pair, "linux-box"))?.status.state,
      ).not.toBe("waiting"),
    { timeout: 10_000 },
  );

  // What its agents had looked at was let go: the next look is a whole outline again.
  const fresh = await callAs(laptop, look, from);
  if (!fresh.ok) throw new Error(fresh.message);
  expect(textOf(fresh.body)).not.toContain("No change since your last look.");
  expect(textOf(fresh.body)).toContain("button 7");
  await window.close();
});
