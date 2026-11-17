import type { ReleaseLine } from "@ace/service/release-line";
import { expect, it } from "vitest";
import { appUpdates } from "./app-updates.ts";

/** The app's update service as one launch of `version` builds it, over a saved line. */
async function launch(version: string, saved: { line: ReleaseLine | null }) {
  const updates = appUpdates({
    version,
    packaged: false,
    platform: "darwin",
    resourcesPath: "/nonexistent",
    execPath: "/nonexistent",
    env: {},
    timers: { set: () => () => {} },
    random: () => 0,
    now: () => 0,
    active: () => false,
    daemonRunning: Promise.resolve(),
    report: () => {},
    drain: async () => true,
    busy: async () => 0,
    prepareQuit: async () => {},
    quit: () => {},
    chosenLine: () => saved.line,
    saveLine: async (line) => {
      saved.line = line;
    },
    homeData: () => undefined,
    freshHomeData: async () => undefined,
    log: () => {},
  });
  await Promise.resolve();
  return updates;
}

it("a beta install keeps the Beta line after it updates to a stable release", async () => {
  const saved: { line: ReleaseLine | null } = { line: null };
  expect((await launch("0.0.24-beta.1", saved)).current().line).toBe("beta");
  expect(saved.line).toBe("beta");
  expect((await launch("0.0.24", saved)).current().line).toBe("beta");
});

it("a stable install with no saved line starts on Stable and keeps it", async () => {
  const saved: { line: ReleaseLine | null } = { line: null };
  expect((await launch("0.0.23", saved)).current().line).toBe("stable");
  expect(saved.line).toBe("stable");
});

it("a saved line is never overwritten by the build's own", async () => {
  const saved: { line: ReleaseLine | null } = { line: "stable" };
  expect((await launch("0.0.24-beta.1", saved)).current().line).toBe("stable");
  expect(saved.line).toBe("stable");
});
