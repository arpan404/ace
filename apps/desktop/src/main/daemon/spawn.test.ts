import { describe, expect, it } from "vitest";
import { DaemonHealth } from "@ace/protocol";
import { daemonEnvironment, daemonProgram, daemonServerLaunch } from "./spawn.ts";

const resources = {
  entry: "/app/Contents/Resources/daemon/ace.mjs",
  node: "/app/Contents/Resources/runtime/bin/node",
  binDirectory: "/app/Contents/Resources/bin",
  packaged: true,
};
const present = () => true;
/** The version the daemon reports when the app runs it at `version`. */
const reported = (version: string) =>
  daemonEnvironment({ home: "/h", resources, path: "/usr/bin", version, env: {} }, {}).ACE_VERSION;
const missing = () => false;
/** The desktop daemon runs in its bundle's daemon folder. */
const cwd = "/app/Contents/Resources/daemon";

describe("the program that runs the daemon", () => {
  it("is the bundled Node runtime in a packaged app, with no run-as-node switch", () => {
    const program = daemonProgram(resources, "/app/Contents/MacOS/ace", present);
    expect(program.command).toBe(resources.node);
    const env = daemonEnvironment(
      {
        home: "/Users/me/.ace",
        resources,
        path: "/usr/bin",
        version: "0.1.0",
        env: {
          ELECTRON_RUN_AS_NODE: "1",
          NODE_OPTIONS: "--inspect",
          // Exported for a benchmark in the shell that opened the app.
          ACE_BENCH_WORKER_PRELOAD: "/repo/apps/daemon/bench/telemetry.mjs",
        },
      },
      program.env,
    );
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.ACE_BENCH_WORKER_PRELOAD).toBeUndefined();
    expect(env.PATH).toBe("/app/Contents/Resources/bin:/usr/bin");
  });

  it("labels its daemon with a version the app's own health check adopts", () => {
    expect(reported("0.0.1")).toBe("0.0.1");
    expect(reported("1.4.2")).toBe("1.4.2");
    expect(reported("1.0.0+local")).toBe("development");
    for (const version of ["0.0.1", "1.4.2", "1.0.0+local"])
      expect(
        DaemonHealth.safeParse({ running: true, version: reported(version), ready: true }).success,
      ).toBe(true);
  });

  it("never falls back to Electron in a packaged app, whose run-as-node fuse is off", () => {
    expect(() => daemonProgram(resources, "/app/Contents/MacOS/ace", missing)).toThrow(
      "bundled Node runtime is missing",
    );
  });

  it("runs the daemon itself as ace Service, on the plain runtime if that cannot start", () => {
    const named = "/app/Contents/Resources/runtime/bin/ace Service";
    const launch = daemonServerLaunch(resources, "/app/Contents/MacOS/ace", () => named, present);
    expect(launch.launches).toEqual([
      // Bun under another name than node would read a .env from the working directory.
      { command: named, args: ["--no-env-file", resources.entry, "start"], cwd },
      { command: resources.node, args: [resources.entry, "start"], cwd },
    ]);
    // An app from before the rename ships only the runtime.
    const old = daemonServerLaunch(resources, "/app/Contents/MacOS/ace", (r) => r, present);
    expect(old.launches).toEqual([
      { command: resources.node, args: [resources.entry, "start"], cwd },
    ]);
    // One-shot commands (doctor) keep the runtime's own name.
    expect(daemonProgram(resources, "/app/Contents/MacOS/ace", present).command).toBe(
      resources.node,
    );
  });

  it("passes Electron as Node none of Bun's flags in development", () => {
    const launch = daemonServerLaunch(
      { ...resources, packaged: false },
      "/repo/node_modules/electron",
      () => "/unused",
      missing,
    );
    expect(launch).toEqual({
      launches: [{ command: "/repo/node_modules/electron", args: [resources.entry, "start"], cwd }],
      env: { ELECTRON_RUN_AS_NODE: "1" },
    });
  });

  it("uses Electron as Node in development when no runtime was staged", () => {
    expect(
      daemonProgram({ ...resources, packaged: false }, "/repo/node_modules/electron", missing),
    ).toEqual({ command: "/repo/node_modules/electron", env: { ELECTRON_RUN_AS_NODE: "1" } });
  });
});
