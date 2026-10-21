import { constants } from "node:os";
import { describe, expect, it } from "vitest";
import { logPriority, raiseDaemonPriority, type PriorityPort } from "./process-priority.ts";

/** Node's error when the OS refuses a priority (an unprivileged negative nice). */
const eacces = Object.assign(
  new Error("A system error occurred: uv_os_setpriority returned EACCES (permission denied)"),
  { code: "ERR_SYSTEM_ERROR", info: { code: "EACCES", errno: -13, syscall: "uv_os_setpriority" } },
);

/** An OS that records each priority it was asked for, refusing with `refusal` if given. */
function os(platform: NodeJS.Platform, refusal?: Error) {
  const asked: number[] = [];
  const port: PriorityPort = {
    platform,
    setPriority(priority) {
      asked.push(priority);
      if (refusal) throw refusal;
    },
  };
  return { port, asked };
}

function logged(outcome: ReturnType<typeof raiseDaemonPriority>) {
  const lines: [string, string, unknown][] = [];
  logPriority(outcome, { log: (level, message, data) => lines.push([level, message, data]) });
  return lines;
}

describe("the daemon's priority at start", () => {
  it("is raised to the above-normal class on Windows and logged once at info", () => {
    const { port, asked } = os("win32");
    const outcome = raiseDaemonPriority(port);
    expect(asked).toEqual([constants.priority.PRIORITY_ABOVE_NORMAL]);
    expect(logged(outcome)).toEqual([
      [
        "info",
        "The daemon runs above normal priority",
        { priority: constants.priority.PRIORITY_ABOVE_NORMAL },
      ],
    ]);
  });

  it("is raised on Linux when the OS allows a negative nice", () => {
    const { port, asked } = os("linux");
    expect(raiseDaemonPriority(port)).toEqual({ kind: "raised", priority: asked[0] });
    expect(asked[0]).toBeLessThan(0);
  });

  it("stays normal without failing when Linux refuses, and says why at info", () => {
    const { port } = os("linux", eacces);
    const outcome = raiseDaemonPriority(port);
    expect(logged(outcome)).toEqual([
      [
        "info",
        "The OS kept the daemon at normal priority",
        { priority: constants.priority.PRIORITY_ABOVE_NORMAL, reason: "EACCES" },
      ],
    ]);
  });

  it("names an unexpected refusal by its message", () => {
    const { port } = os("win32", new Error("Access is denied"));
    expect(raiseDaemonPriority(port)).toMatchObject({
      kind: "refused",
      reason: "Access is denied",
    });
  });

  it("is left alone on macOS, where only the desktop's launch can raise it", () => {
    const { port, asked } = os("darwin");
    const outcome = raiseDaemonPriority(port);
    expect(asked).toEqual([]);
    expect(logged(outcome)).toEqual([]);
  });
});
