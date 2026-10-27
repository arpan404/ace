import { mkdirSync, mkdtempSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { MachineToolResult, ProviderKind, type MachineCall } from "@ace/protocol";
import { pairedMachines } from "./machine-test-support.ts";
import { callAs, fleetWindow, sourceProfile } from "./grants-test-support.ts";

type Pair = Awaited<ReturnType<typeof pairedMachines>>;
const from = { host: "linux-box", thread: "build-the-app" };
const tool = (name: string, args: Record<string, unknown>): MachineCall => ({
  op: "commands",
  tool: name,
  args,
});
const run = (args: Record<string, unknown>) => tool("command_run", { project: "project", ...args });
/** The text parts of a tool result, in order. */
function texts(result: Awaited<ReturnType<typeof callAs>>): string[] {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return MachineToolResult.parse(result.body).content.flatMap((part) =>
    part.type === "text" ? [part.text] : [],
  );
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
/** A target with nothing installed, whose person allows the laptop's agents `level` commands. */
async function commandsAllowed(level: "off" | "read" | "operate") {
  const pair = await pairedMachines({ access: "operate" });
  const { registry } = pair.target.h;
  for (const provider of ProviderKind.options)
    if (registry.has(provider)) registry.get(provider).discovery.installed = false;
  const window = await fleetWindow(pair.target);
  const laptop = sourceProfile(pair);
  if (level !== "off") await window.set(laptop.deviceId, "commands", level);
  return { pair, window, laptop, project: pair.target.h.home };
}
function guestThread(pair: Pair) {
  const thread = pair.target.daemon.store
    .listThreads()
    .find((candidate) => candidate.details?.guest?.host === from.host);
  if (!thread) throw new Error("No guest session");
  return thread;
}
async function pidFrom(path: string): Promise<number> {
  await vi.waitFor(() => expect(existsSync(path)).toBe(true), { timeout: 15_000 });
  return Number(readFileSync(path, "utf8").trim());
}

it("commands are off until the person allows them, and read only runs none", async () => {
  const { pair, window, laptop } = await commandsAllowed("off");
  expect(await callAs(laptop, run({ command: "echo hi" }), from)).toMatchObject({
    ok: false,
    code: "machine_forbidden",
    message: expect.stringContaining("Commands is off here"),
  });
  await window.set(laptop.deviceId, "commands", "read");
  expect(await callAs(laptop, run({ command: "echo hi" }), from)).toMatchObject({
    ok: false,
    code: "machine_forbidden",
    message: expect.stringContaining("may only read"),
  });
  // Nothing ran: no session was ever opened for the calling thread.
  expect(pair.target.daemon.store.listThreads().filter((thread) => thread.details?.guest)).toEqual(
    [],
  );
  await window.close();
});

it("an allowed machine runs a command in a project here with no provider installed, and it is recorded", async () => {
  const { pair, window, laptop, project } = await commandsAllowed("operate");
  mkdirSync(join(project, "app"));
  const result = texts(
    await callAs(
      laptop,
      run({ command: "pwd; echo built; echo warned >&2; exit 3", cwd: "app" }),
      from,
    ),
  );
  expect(result[0]).toContain("Exit code 3");
  expect(result[1]).toBe(`stdout:\n${realpathSync(join(project, "app"))}\nbuilt\n`);
  expect(result[2]).toBe("stderr:\nwarned\n");

  // The calling thread's guest session holds the record: command, folder and exit code.
  const thread = guestThread(pair);
  const items = pair.target.daemon.store.readItems(thread.id, Number.MAX_SAFE_INTEGER, 20).items;
  expect(items).toContainEqual(
    expect.objectContaining({
      type: "tool_call",
      call: expect.objectContaining({
        status: "failed",
        detail: expect.objectContaining({
          kind: "shell",
          command: "pwd; echo built; echo warned >&2; exit 3",
          cwd: realpathSync(join(project, "app")),
          exitCode: 3,
        }),
      }),
    }),
  );
  expect(thread.status.state).not.toBe("working");
  // A read-only thread on the calling machine never runs one.
  expect(
    await callAs(laptop, run({ command: "echo hi" }), { ...from, ceiling: "read" }),
  ).toMatchObject({ ok: false, code: "machine_forbidden" });
  await window.close();
});

it("a command can't leave the project, by .., an absolute path or a link", async () => {
  const { window, laptop, project } = await commandsAllowed("operate");
  const outside = mkdtempSync(join(tmpdir(), "ace-outside-"));
  symlinkSync(outside, join(project, "escape"));
  for (const cwd of ["..", "../..", "app/../../x", outside, "/", "escape"])
    expect(await callAs(laptop, run({ command: "pwd", cwd }), from), cwd).toMatchObject({
      ok: false,
      code: "invalid",
      message: expect.stringContaining("inside the project"),
    });
  expect(await callAs(laptop, run({ command: "pwd", project: "elsewhere" }), from)).toMatchObject({
    ok: false,
    message: expect.stringContaining('No project "elsewhere"'),
  });
  await window.close();
});

it("long output comes back as its last 64 KB with a note, and a timeout stops the whole tree", async () => {
  const { window, laptop, project } = await commandsAllowed("operate");
  const [, stdout] = texts(
    await callAs(
      laptop,
      run({ command: "head -c 200000 /dev/zero | tr '\\0' a; echo; echo END" }),
      from,
    ),
  );
  expect(stdout).toMatch(/^stdout:\n\[first \d+ bytes dropped; the last 65536 follow\]\n/);
  expect(stdout?.endsWith("a\nEND\n")).toBe(true);
  expect(stdout?.length).toBeLessThan(66_000);

  const started = Date.now();
  const timedOut = texts(
    await callAs(
      laptop,
      run({ command: "sleep 60 & echo $! > sleeper.pid; wait", timeoutSeconds: 1 }),
      from,
    ),
  );
  expect(timedOut[0]).toContain("Timed out");
  expect(Date.now() - started).toBeLessThan(15_000);
  const sleeper = await pidFrom(join(project, "sleeper.pid"));
  await vi.waitFor(() => expect(alive(sleeper)).toBe(false), { timeout: 10_000 });
  await window.close();
});

it("a background job runs until stopped, shows on this machine, and keeps its session from reading done", async () => {
  const { pair, window, laptop } = await commandsAllowed("operate");
  const started = texts(
    await callAs(
      laptop,
      run({ command: "echo serving; echo oops >&2; sleep 60", background: true }),
      from,
    ),
  )[0];
  const jobId = /job-[a-z0-9-]+/.exec(started ?? "")?.[0];
  if (!jobId) throw new Error(`No job id in ${started}`);
  const thread = () => guestThread(pair);
  await vi.waitFor(() => expect(thread().status.state).toBe("waiting"), { timeout: 10_000 });
  expect(texts(await callAs(laptop, tool("command_status", { jobId }), from))[0]).toContain(
    "Running for",
  );
  await vi.waitFor(async () =>
    expect(texts(await callAs(laptop, tool("command_output", { jobId }), from))[1]).toBe(
      "serving\n",
    ),
  );
  expect(
    texts(await callAs(laptop, tool("command_output", { jobId, stream: "stderr" }), from))[1],
  ).toBe("oops\n");
  // Another calling thread can't name this one's job.
  expect(
    await callAs(laptop, tool("command_status", { jobId }), { ...from, thread: "another" }),
  ).toMatchObject({ ok: false, message: expect.stringContaining("No such command job") });

  expect(texts(await callAs(laptop, tool("command_stop", { jobId }), from))[0]).toContain(
    "Stopped",
  );
  expect(texts(await callAs(laptop, tool("command_status", { jobId }), from))[0]).toContain(
    "Stopped",
  );
  await vi.waitFor(() => expect(thread().status.state).not.toBe("waiting"), { timeout: 10_000 });
  await window.close();
});

it("turning Commands down ends that machine's running jobs and every process they started", async () => {
  const { pair, window, laptop, project } = await commandsAllowed("operate");
  const answer = texts(
    await callAs(
      laptop,
      run({ command: "sleep 60 & echo $! > server.pid; wait", background: true }),
      from,
    ),
  );
  expect(answer[0]).toContain("Started");
  const server = await pidFrom(join(project, "server.pid"));
  expect(alive(server)).toBe(true);
  await window.set(laptop.deviceId, "commands", "read");
  await vi.waitFor(() => expect(alive(server)).toBe(false), { timeout: 10_000 });
  await vi.waitFor(() => expect(guestThread(pair).status.state).not.toBe("waiting"), {
    timeout: 10_000,
  });
  await window.close();
});
