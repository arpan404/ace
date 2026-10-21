import { describe, expect, it } from "vitest";
import { daemonLaunchPolicy, type LaunchPriorityPort } from "./launch-priority.ts";

const daemon = {
  command: "/Applications/ace.app/Contents/Resources/runtime/bin/node",
  args: ["/Applications/ace.app/Contents/Resources/daemon/ace.mjs", "start"],
};

/** An OS whose dry runs answer from `answers`, in order. */
function os(platform: NodeJS.Platform, ...answers: boolean[]): LaunchPriorityPort {
  return { platform, succeeds: () => answers.shift() ?? false };
}

describe("the daemon's launch", () => {
  it("goes through taskpolicy as an application on macOS, with its own command and arguments", () => {
    expect(daemonLaunchPolicy(os("darwin", true))(daemon)).toEqual({
      command: "/usr/sbin/taskpolicy",
      args: ["-a", daemon.command, ...daemon.args],
    });
  });

  it("is spawned as is on macOS when taskpolicy cannot run, so the daemon still starts", () => {
    expect(daemonLaunchPolicy(os("darwin", false))(daemon)).toEqual(daemon);
  });

  it("keeps the first answer for later restarts", () => {
    const prioritize = daemonLaunchPolicy(os("darwin", true, false));
    prioritize(daemon);
    expect(prioritize(daemon).command).toBe("/usr/sbin/taskpolicy");
  });

  it("is spawned as is on Windows and Linux, where the daemon raises itself", () => {
    for (const platform of ["win32", "linux"] as const)
      expect(daemonLaunchPolicy(os(platform, true))(daemon)).toEqual(daemon);
  });
});
