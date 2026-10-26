import { describe, expect, it } from "vitest";
import { planUpdateLaunch } from "./index.ts";

const base = {
  node: "/home/a/.ace/releases/1.0.0-linux-x64/bin/node",
  args: ["/home/a/.ace/releases/1.0.0-linux-x64/ace.mjs", "update", "apply"],
  root: "/home/a/.ace",
};

describe("the updater's launch", () => {
  it("runs as its own transient unit when systemd supervises ace, so stopping ace cannot kill it", () => {
    const launch = planUpdateLaunch({
      ...base,
      platform: "linux",
      env: { INVOCATION_ID: "5f1c", PATH: "/usr/local/bin:/usr/bin" },
    });
    expect(launch.command).toBe("systemd-run");
    expect(launch.args).toEqual(expect.arrayContaining(["--user", "--wait"]));
    expect(launch.args).toContain("--setenv=ACE_HOME=/home/a/.ace");
    expect(launch.args).toContain("--setenv=PATH=/usr/local/bin:/usr/bin");
    expect(launch.args.slice(launch.args.indexOf("--") + 1)).toEqual([base.node, ...base.args]);
  });

  it("runs detached without systemd-run on Linux with no systemd user session", () => {
    expect(planUpdateLaunch({ ...base, platform: "linux", env: { PATH: "/usr/bin" } })).toEqual({
      command: base.node,
      args: base.args,
      detached: true,
    });
  });

  it("runs detached under launchd", () => {
    expect(
      planUpdateLaunch({ ...base, platform: "darwin", env: { INVOCATION_ID: "unrelated" } }),
    ).toMatchObject({ command: base.node, detached: true });
  });
});
