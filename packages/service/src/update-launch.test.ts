import { describe, expect, it } from "vitest";
import { planUpdateLaunch } from "./index.ts";

const base = {
  node: "/home/a/.ace/releases/1.0.0-linux-x64/bin/node",
  args: ["/home/a/.ace/releases/1.0.0-linux-x64/ace.mjs", "update", "apply"],
  root: "/home/a/.ace",
  userHome: "/home/a",
  canonical: (path: string) => path,
};

const underSystemd = {
  platform: "linux" as const,
  env: { INVOCATION_ID: "5f1c", PATH: "/usr/bin" },
};

/**
 * `systemd-run --unit=<name>` as systemd answers it: a transient unit whose name is already
 * active is refused until it finishes.
 */
function transientUnits() {
  const active = new Set<string>();
  return {
    start(launch: { args: string[] }): "started" | "refused" {
      const unit = launch.args.find((arg) => arg.startsWith("--unit="));
      if (!unit) throw new Error("no unit name");
      if (active.has(unit)) return "refused";
      active.add(unit);
      return "started";
    },
  };
}

const forHome = (root: string) => planUpdateLaunch({ ...base, ...underSystemd, root });

/** `/var/tmp/link` is a link to `/var/tmp/real`. */
const throughLink = (path: string) => path.replace("/var/tmp/link", "/var/tmp/real");

const linkedUnit = (root: string) =>
  planUpdateLaunch({ ...base, ...underSystemd, root, canonical: throughLink }).args.find((arg) =>
    arg.startsWith("--unit="),
  );

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

  it("keeps the default home's updater unit name", () => {
    expect(planUpdateLaunch({ ...base, ...underSystemd }).args).toContain("--unit=ace-update");
  });

  it("lets two homes update at once, and still refuses a second update of the same home", () => {
    const units = transientUnits();
    // Both updates are launched before either finishes.
    expect([
      units.start(forHome("/home/a/.ace")),
      units.start(forHome("/var/tmp/dev-home")),
    ]).toEqual(["started", "started"]);
    expect(units.start(forHome("/var/tmp/dev-home/"))).toBe("refused");
    expect(units.start(forHome("/home/a/.ace"))).toBe("refused");
  });

  it("names one home's updater the same through any spelling of its folder", () => {
    expect(linkedUnit("/var/tmp/link/home")).toBe(linkedUnit("/var/tmp/real/home"));
    expect(linkedUnit("/var/tmp/real/home")).toMatch(/^--unit=ace-update-[0-9a-f]{10}$/);
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
