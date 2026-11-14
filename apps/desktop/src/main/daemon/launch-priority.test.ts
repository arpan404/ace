import { describe, expect, it } from "vitest";
import { daemonLaunchPolicy, type LaunchPriorityPort } from "./launch-priority.ts";

const daemon = {
  command: "/Applications/ace.app/Contents/Resources/runtime/bin/node",
  args: ["/Applications/ace.app/Contents/Resources/daemon/ace.mjs", "start"],
};

/** An OS whose dry runs answer from `answers`, in order. */
function os(platform: NodeJS.Platform, ...answers: boolean[]): LaunchPriorityPort {
  return { platform, succeeds: async () => answers.shift() ?? false };
}

async function ready(port: LaunchPriorityPort) {
  const policy = daemonLaunchPolicy(port);
  await policy.ready();
  return policy;
}

describe("the daemon's launch", () => {
  it("goes through taskpolicy as an application on macOS, with its own command and arguments", async () => {
    expect((await ready(os("darwin", true))).wrap(daemon)).toEqual({
      command: "/usr/sbin/taskpolicy",
      args: ["-a", daemon.command, ...daemon.args],
    });
  });

  it("is spawned as is on macOS when taskpolicy cannot run, so the daemon still starts", async () => {
    expect((await ready(os("darwin", false))).wrap(daemon)).toEqual(daemon);
  });

  it("is spawned as is while the dry run has not answered, so a spawn never waits on it", () => {
    const policy = daemonLaunchPolicy({
      platform: "darwin",
      succeeds: () => new Promise(() => {}),
    });
    void policy.ready();
    expect(policy.wrap(daemon)).toEqual(daemon);
  });

  it("runs the dry run once and keeps its answer for later restarts", async () => {
    const policy = await ready(os("darwin", true, false));
    await policy.ready();
    expect(policy.wrap(daemon).command).toBe("/usr/sbin/taskpolicy");
  });

  it("is spawned as is on Windows and Linux, where the daemon raises itself", async () => {
    for (const platform of ["win32", "linux"] as const)
      expect((await ready(os(platform, true))).wrap(daemon)).toEqual(daemon);
  });
});
