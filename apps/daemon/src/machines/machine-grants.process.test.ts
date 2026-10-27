import { expect, it, vi } from "vitest";
import { z } from "zod";
import {
  MachineSessionResult,
  MachineSummary,
  MachineToolResult,
  ProviderKind,
} from "@ace/protocol";
import { pairedMachines } from "./machine-test-support.ts";
import { callAs, fleetWindow, secondMachine, sourceProfile } from "./grants-test-support.ts";

const Machines = z.object({ machines: z.array(MachineSummary) });
const open = {
  op: "browser",
  tool: "browser_open",
  args: { url: "https://docs.example.test/start" },
} as const;

it("each linked machine gets its own capabilities, and a change applies to its next call", async () => {
  const pair = await pairedMachines({ access: "operate" });
  const window = await fleetWindow(pair.target);
  const laptop = sourceProfile(pair);
  const build = await secondMachine(pair);
  const listed = async () =>
    Machines.parse((await pair.source.call({ op: "machines" })).data).machines;

  // Out of the box: agents and browser as the machine's switch says, simulators allowed,
  // computer use and commands off.
  expect((await window.grants()).devices).toContainEqual({
    deviceId: laptop.deviceId,
    grants: {
      agents: "operate",
      browser: "operate",
      devices: "operate",
      screen: "off",
      commands: "off",
    },
    chosen: [],
  });
  const [studio] = await listed();
  expect(studio?.tools).toEqual(expect.arrayContaining(["agents", "browser"]));
  expect(studio?.tools).not.toContain("screen");
  expect(studio?.tools).not.toContain("commands");
  expect(studio?.grants).toMatchObject({ screen: "off", commands: "off", devices: "operate" });

  // The person turns the browser off for the laptop only: its next call is refused, the build
  // server's isn't.
  await window.set(laptop.deviceId, "browser", "off");
  expect(await callAs(laptop, open)).toMatchObject({
    ok: false,
    code: "machine_forbidden",
    message: expect.stringContaining("Browser is off"),
  });
  const built = await callAs(build, open);
  expect(built.ok, JSON.stringify(built)).toBe(true);
  expect(await listed()).toEqual([
    expect.objectContaining({ tools: expect.not.arrayContaining(["browser"]) }),
  ]);

  // Read only: reading pages still works, acting doesn't.
  await window.set(laptop.deviceId, "browser", "read");
  expect(await callAs(laptop, open)).toMatchObject({
    ok: false,
    code: "machine_forbidden",
    message: expect.stringContaining("only read"),
  });
  expect(await callAs(laptop, { op: "browser.session" })).toMatchObject({ ok: true });

  // Commands, once on for the laptop, pass the grant; this build doesn't run them yet.
  const command = { op: "commands", tool: "command_run", args: { command: "ls" } } as const;
  expect(await callAs(laptop, command)).toMatchObject({ ok: false, code: "machine_forbidden" });
  await window.set(laptop.deviceId, "commands", "operate");
  expect(await callAs(laptop, command)).toMatchObject({ ok: false, code: "not_supported" });
  expect(await callAs(build, command)).toMatchObject({ ok: false, code: "machine_forbidden" });
  expect((await listed())[0]?.tools).toContain("commands");

  // Computer use stays off by default for both.
  const screen = { op: "screen", tool: "screen_state", args: {} } as const;
  for (const machine of [laptop, build])
    expect(await callAs(machine, screen)).toMatchObject({
      ok: false,
      code: "machine_forbidden",
      message: expect.stringContaining("Computer use is off"),
    });

  // Agents read only: the laptop still sees the machine but can't start work there.
  await window.set(laptop.deviceId, "agents", "read");
  expect(await listed()).toHaveLength(1);
  await expect(
    pair.source.call({
      op: "delegate_task",
      requestId: "after-read-only",
      task: "Summarize",
      role: "Summarize",
      provider: "claude",
      machine: "studio",
      project: "project",
    }),
  ).rejects.toMatchObject({ code: "machine_forbidden" });
  expect((await window.grants()).devices).toContainEqual(
    expect.objectContaining({
      deviceId: laptop.deviceId,
      chosen: ["agents", "browser", "commands"],
    }),
  );

  // The machine-wide switch still closes it to everything, whatever each grant says.
  await pair.access("off");
  expect(await listed()).toEqual([]);
  expect(await callAs(laptop, command)).toMatchObject({ ok: false, code: "machine_opted_out" });
  await window.close();
});

it("a read-only thread on the calling machine can read there but never act", async () => {
  const pair = await pairedMachines({ access: "operate" });
  const laptop = sourceProfile(pair);
  const readOnly = { host: "laptop", thread: "reviewing", ceiling: "read" } as const;
  expect(await callAs(laptop, open, readOnly)).toMatchObject({
    ok: false,
    code: "machine_forbidden",
    message: expect.stringContaining("read-only"),
  });
  expect(await callAs(laptop, { op: "browser.session" }, readOnly)).toMatchObject({ ok: true });
});

it("a machine with no provider installed serves another machine's browser calls", async () => {
  const pair = await pairedMachines({ access: "operate" });
  // Nothing is installed there: no CLI an agent could run in.
  const { registry } = pair.target.h;
  for (const provider of ProviderKind.options)
    if (registry.has(provider)) registry.get(provider).discovery.installed = false;
  const [studio] = Machines.parse((await pair.source.call({ op: "machines" })).data).machines;
  expect(studio).toMatchObject({ providers: [], tools: expect.arrayContaining(["browser"]) });

  const laptop = sourceProfile(pair);
  const from = { host: "linux-box", thread: "fix-login" };
  const result = await callAs(laptop, open, from);
  if (!result.ok) throw new Error(result.message);
  expect(MachineToolResult.parse(result.body).content[0]).toMatchObject({
    text: expect.stringContaining("docs.example.test"),
  });

  // The work is held by a guest session there, named for the calling machine and thread, which
  // the person sees and which reads done only once nothing runs in it.
  const session = await callAs(laptop, { op: "browser.session" }, from);
  if (!session.ok) throw new Error(session.message);
  const { threadId } = MachineSessionResult.parse(session.body);
  const thread = pair.target.daemon.store.getThread(threadId);
  expect(thread).toMatchObject({
    title: "linux-box · Check the release",
    hasSentMessage: true,
    details: { guest: { host: "linux-box", name: "linux-box" } },
  });
  expect(thread?.status.state).not.toBe("working");
  // The same calling thread gets the same session; another calling thread its own.
  const again = await callAs(laptop, { op: "browser.session" }, from);
  expect(again).toMatchObject({ ok: true, body: { threadId } });
  const other = await callAs(laptop, { op: "browser.session" }, { ...from, thread: "other" });
  expect(other).toMatchObject({
    ok: true,
    body: { threadId: expect.not.stringMatching(threadId) },
  });
});

it("turning a capability off stops that machine's work in flight, and the session settles", async () => {
  const pair = await pairedMachines({ access: "operate" });
  const window = await fleetWindow(pair.target);
  const laptop = sourceProfile(pair);
  const from = { host: "linux-box", thread: "long-wait" };
  expect(await callAs(laptop, open, from)).toMatchObject({ ok: true });
  const session = await callAs(laptop, { op: "browser.session" }, from);
  if (!session.ok) throw new Error(session.message);
  const { threadId } = MachineSessionResult.parse(session.body);

  const started = Date.now();
  const waiting = callAs(
    laptop,
    { op: "browser", tool: "browser_wait_for", args: { timeMs: 25_000 } },
    from,
  );
  // While it runs, the session shows work and never reads done.
  await vi.waitFor(
    () => expect(pair.target.daemon.store.getThread(threadId)?.status.state).toBe("waiting"),
    { timeout: 10_000 },
  );
  await window.set(laptop.deviceId, "browser", "off");
  expect(await waiting).toMatchObject({
    ok: false,
    code: "machine_forbidden",
    message: expect.stringContaining("turned this off"),
  });
  expect(Date.now() - started).toBeLessThan(20_000);
  await vi.waitFor(
    () => expect(pair.target.daemon.store.getThread(threadId)?.status.state).not.toBe("waiting"),
    { timeout: 10_000 },
  );
  await window.close();
});
