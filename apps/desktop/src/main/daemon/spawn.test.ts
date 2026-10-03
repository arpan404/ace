import { describe, expect, it } from "vitest";
import { daemonEnvironment, daemonProgram } from "./spawn.ts";

const resources = {
  entry: "/app/Contents/Resources/daemon/ace.mjs",
  node: "/app/Contents/Resources/runtime/bin/node",
  binDirectory: "/app/Contents/Resources/bin",
  packaged: true,
};
const present = () => true;
const missing = () => false;

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
        env: { ELECTRON_RUN_AS_NODE: "1", NODE_OPTIONS: "--inspect" },
      },
      program.env,
    );
    expect(env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.PATH).toBe("/app/Contents/Resources/bin:/usr/bin");
  });

  it("never falls back to Electron in a packaged app, whose run-as-node fuse is off", () => {
    expect(() => daemonProgram(resources, "/app/Contents/MacOS/ace", missing)).toThrow(
      "bundled Node runtime is missing",
    );
  });

  it("uses Electron as Node in development when no runtime was staged", () => {
    expect(
      daemonProgram({ ...resources, packaged: false }, "/repo/node_modules/electron", missing),
    ).toEqual({ command: "/repo/node_modules/electron", env: { ELECTRON_RUN_AS_NODE: "1" } });
  });
});
