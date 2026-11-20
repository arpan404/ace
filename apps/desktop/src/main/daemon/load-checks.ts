import { pressureFields, pressureVerdict, type PressureVerdict } from "@ace/diagnostics/pressure";
import { healthVerdict, startupVerdict, type HealthVerdict, type StallReading } from "./grace.ts";
import type { SupervisorPorts } from "./supervisor-config.ts";

type LoadPorts = Pick<SupervisorPorts, "pressure" | "stall" | "startupProgress">;

/** Whether the supervisor can tell a starved daemon from a hung one at all. */
export function loadAware(ports: LoadPorts): boolean {
  return !!(ports.pressure || ports.stall || ports.startupProgress);
}

/** The machine's pressure, with its log fields; undefined when it cannot be read. */
export async function readPressure(
  ports: LoadPorts,
): Promise<{ verdict: PressureVerdict; fields: Record<string, unknown> } | undefined> {
  if (!ports.pressure) return undefined;
  try {
    const pressure = await ports.pressure();
    return { verdict: pressureVerdict(pressure), fields: pressureFields(pressure) };
  } catch {
    return undefined;
  }
}

async function readStall(ports: LoadPorts, pid: number | undefined) {
  if (!ports.stall || pid === undefined) return undefined;
  try {
    return await ports.stall(pid);
  } catch {
    return undefined;
  }
}

/** What to do with a daemon that missed its health checks, and the numbers behind it. */
export async function assessUnresponsive(
  ports: LoadPorts,
  facts: { pid: number | undefined; unansweredMs: number; graces: number },
): Promise<{ verdict: HealthVerdict; data: Record<string, unknown> }> {
  const [pressure, stall] = await Promise.all([readPressure(ports), readStall(ports, facts.pid)]);
  const verdict = healthVerdict({
    unansweredMs: facts.unansweredMs,
    graces: facts.graces,
    pressure: pressure?.verdict,
    stall,
  });
  return {
    verdict,
    data: {
      why: verdict.why,
      unansweredMs: Math.round(facts.unansweredMs),
      graces: facts.graces,
      ...(verdict.kind === "wait" ? { graceMs: verdict.graceMs } : {}),
      ...(pressure ? { ...pressure.fields, pressure: pressure.verdict.reasons } : {}),
      ...(stall ? { stall: stallFields(stall) } : {}),
    },
  };
}

function stallFields(stall: StallReading): Record<string, unknown> {
  return {
    silentMs: stall.silentMs,
    cpuMs: stall.cpuMs ?? null,
    watchdogLateMs: stall.watchdogLateMs ?? null,
    ageMs: Math.round(stall.ageMs),
  };
}

/** The starting daemon's progress mark; undefined when there is none to read. */
export async function progressMark(
  ports: LoadPorts,
  pid: number | undefined,
): Promise<string | undefined> {
  if (!ports.startupProgress || pid === undefined) return undefined;
  try {
    return await ports.startupProgress(pid);
  } catch {
    return undefined;
  }
}

/** What to do with a start past its ready budget, given the progress mark seen last. */
export async function assessStartup(
  ports: LoadPorts,
  facts: { pid: number | undefined; waitedMs: number; mark: string | undefined },
): Promise<{ verdict: HealthVerdict; mark: string | undefined; data: Record<string, unknown> }> {
  const [pressure, mark] = await Promise.all([readPressure(ports), progressMark(ports, facts.pid)]);
  const progressed = mark !== undefined && mark !== facts.mark;
  const verdict = startupVerdict({
    waitedMs: facts.waitedMs,
    progressed,
    pressure: pressure?.verdict,
  });
  return {
    verdict,
    mark,
    data: {
      why: verdict.why,
      waitedMs: Math.round(facts.waitedMs),
      progressed,
      ...(verdict.kind === "wait" ? { graceMs: verdict.graceMs } : {}),
      ...(pressure ? { ...pressure.fields, pressure: pressure.verdict.reasons } : {}),
    },
  };
}
