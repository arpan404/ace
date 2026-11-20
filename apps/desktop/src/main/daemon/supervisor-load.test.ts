import type { SystemPressure } from "@ace/diagnostics/pressure";
import { describe, expect, it } from "vitest";
import type { StallReading } from "./grace.ts";
import { DaemonSupervisor } from "./supervisor.ts";
import { machine } from "./supervisor-test-support.ts";

const idle: SystemPressure = { cpus: 16, load1: 1 };
const overloaded: SystemPressure = { cpus: 16, load1: 96 };

/** A fake machine whose load, stall report and startup progress the test sets. */
function loaded() {
  const m = machine();
  const load = {
    pressure: idle,
    stall: undefined as StallReading | undefined,
    progress: 0,
  };
  // The stall and progress files are per pid.
  const spawn = m.ports.spawn;
  let pid = 1_000;
  if (spawn) m.ports.spawn = (launch) => Object.assign(spawn(launch), { pid: pid++ });
  m.ports.pressure = async () => load.pressure;
  m.ports.stall = async () => load.stall;
  m.ports.startupProgress = async () => String(load.progress);
  return { ...m, load };
}

async function runningDaemon(m: ReturnType<typeof loaded>) {
  const supervisor = new DaemonSupervisor(m.ports, { stopGraceMs: 10_000 });
  await supervisor.start();
  m.state.answering = true;
  await m.advance(300);
  expect(supervisor.current().state).toBe("running");
  return supervisor;
}

const messages = (m: ReturnType<typeof loaded>) => m.log.map((entry) => entry.message);

describe("a daemon that stops answering", () => {
  it("is left running while the machine starves it, and carries on once it answers", async () => {
    const m = loaded();
    const supervisor = await runningDaemon(m);
    m.load.pressure = overloaded;
    m.load.stall = { silentMs: 38_911, cpuMs: 107, watchdogLateMs: 4_000, ageMs: 1_000 };
    m.state.hung = true;
    await m.advance(150_000);
    expect(m.signals).toEqual([]);
    expect(supervisor.current().state).toBe("running");
    expect(m.log).toContainEqual(
      expect.objectContaining({
        message: "The daemon is slow to answer; giving it longer",
        data: expect.objectContaining({
          why: "starved of CPU, not hung",
          load1: 96,
          graceMs: 15_000,
        }),
      }),
    );
    m.state.hung = false;
    m.load.stall = undefined;
    await m.advance(60_000);
    expect(m.signals).toEqual([]);
    expect(supervisor.current().state).toBe("running");
  });

  it("is stopped after its missed checks when the machine has CPU to spare", async () => {
    const m = loaded();
    await runningDaemon(m);
    m.state.hung = true;
    let waited = 0;
    while (m.signals.length === 0 && waited < 120_000) {
      await m.advance(1_000);
      waited += 1_000;
    }
    expect(m.signals).toEqual(["SIGTERM"]);
    expect(waited).toBeLessThan(60_000);
    expect(m.log).toContainEqual(
      expect.objectContaining({
        message: "The daemon stopped answering health checks; stopping it",
        data: expect.objectContaining({ why: "silent on a calm machine", load1: 1 }),
      }),
    );
  });

  it("is stopped at the ceiling however loaded the machine stays", async () => {
    const m = loaded();
    await runningDaemon(m);
    m.load.pressure = overloaded;
    m.state.hung = true;
    await m.advance(280_000);
    expect(m.signals).toEqual([]);
    await m.advance(200_000);
    expect(m.signals[0]).toBe("SIGTERM");
    expect(m.log).toContainEqual(
      expect.objectContaining({
        message: "The daemon stopped answering health checks; stopping it",
        data: expect.objectContaining({ why: "silent past the ceiling" }),
      }),
    );
  });
});

describe("a daemon still starting", () => {
  it("is not stopped as not ready while it keeps writing", async () => {
    const m = loaded();
    const supervisor = new DaemonSupervisor(m.ports, { readyTimeoutMs: 10_000 });
    await supervisor.start();
    for (let second = 0; second < 40; second++) {
      m.load.progress++;
      await m.advance(1_000);
    }
    expect(m.signals).toEqual([]);
    expect(messages(m)).toContain("The daemon is still starting; waiting longer");
    m.state.answering = true;
    await m.advance(2_000);
    expect(supervisor.current().state).toBe("running");
  });

  it("is stopped as not ready when it shows no progress on a calm machine", async () => {
    const m = loaded();
    await new DaemonSupervisor(m.ports, { readyTimeoutMs: 10_000 }).start();
    await m.advance(11_000);
    expect(m.signals).toEqual(["SIGTERM"]);
    expect(m.log).toContainEqual(
      expect.objectContaining({
        message: "The daemon did not become ready; restarting it",
        data: expect.objectContaining({ why: "no startup progress on a calm machine" }),
      }),
    );
  });
});

describe("restarts", () => {
  it("wait longer on an overloaded machine, so they never run back to back", async () => {
    const m = loaded();
    const supervisor = new DaemonSupervisor(m.ports);
    await supervisor.start();
    m.load.pressure = overloaded;
    m.children[0]?.die(1);
    await m.advance(4_000);
    expect(m.children).toHaveLength(1);
    await m.advance(1_500);
    expect(m.children).toHaveLength(2);
    m.children[1]?.die(1);
    await m.advance(9_000);
    expect(m.children).toHaveLength(2);
    await m.advance(1_500);
    expect(m.children).toHaveLength(3);
    expect(messages(m)).toContain("The machine is overloaded; waiting longer before the restart");
  });

  it("keep the crash backoff on a calm machine", async () => {
    const m = loaded();
    await new DaemonSupervisor(m.ports).start();
    m.children[0]?.die(1);
    await m.advance(600);
    expect(m.children).toHaveLength(2);
  });
});
