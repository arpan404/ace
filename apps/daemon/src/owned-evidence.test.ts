import { expect, test } from "vitest";
import { fakeMachine } from "@ace/provider-kit/process-tree-test-support";
import { runsAceDaemon, signallable } from "./owned-evidence.ts";
import { stopVerdict } from "./cli/daemon-stop.ts";

const run = "0b9e2c4c-7f3a-4c1e-9a55-2f1d8e6b7a10";
const marked = [`ACE_PROCESS_OWNER=${run}`];
const daemon = { pid: 100, start: "daemon" };

/** This run's daemon (100) under a terminal (50), and what the cases put around it. */
function machine() {
  return fakeMachine({
    50: { parent: 1, start: "terminal" },
    100: { parent: 50, start: "daemon", argv: ["bun", "apps/daemon/src/cli.ts", "start"] },
    // A marked orphan of this run's: the one candidate the rules let through.
    200: { parent: 1, start: "orphan", env: marked },
    // The updater, launched to outlive the daemon, and a helper it started.
    300: { parent: 100, start: "updater", env: [...marked, "ACE_PROCESS_KEEP=1"] },
    301: { parent: 300, start: "installer", env: marked },
    // An editor whose environment is hidden (an Apple binary), known by its recorded row.
    310: { parent: 1, start: "editor" },
    // Home B's daemon, started from this run's agent shell: it carries this run's marker.
    400: {
      parent: 1,
      start: "home-b-daemon",
      env: [...marked, "ACE_HOME=/homes/b"],
      argv: ["/usr/local/bin/node", "/homes/b/releases/1/ace.mjs", "start"],
    },
    401: { parent: 400, start: "home-b-provider", env: marked },
    // Home C's daemon, recognised by its home's run marker alone.
    500: { parent: 1, start: "home-c-daemon", env: [...marked, "ACE_HOME=/homes/c"], argv: ["x"] },
    501: { parent: 500, start: "home-c-provider", env: marked },
    // `ace stop` run from this run's provider shell, and that shell.
    600: { parent: 100, start: "provider-shell", env: marked },
    601: { parent: 600, start: "ace-stop", env: marked },
  });
}

test("a sweep signals only candidates no rule spares", () => {
  const { listing } = machine();
  const allowed = signallable(listing, {
    self: daemon,
    spare: new Set([600, 601]),
    kept: [{ pid: 310, start: "editor" }],
    readMarker: (home) =>
      home === "/homes/c" ? { state: "running", pid: 500, startedAt: 1 } : undefined,
  });
  const verdicts = Object.fromEntries(
    [...listing.all()].map((pid) => {
      const info = listing.info(pid);
      return [pid, info ? allowed({ pid, start: info.start }) : false];
    }),
  );
  expect(verdicts).toMatchObject({
    200: true,
    // Kept by its marker, and its helper for being below it.
    300: false,
    301: false,
    // Kept by its recorded pid and start, whatever its environment shows.
    310: false,
    // Another home's daemon, by its command line, and everything below it.
    400: false,
    401: false,
    // Another home's daemon, by its home's run marker, and everything below it.
    500: false,
    501: false,
    // The stop's caller chain.
    600: false,
    601: false,
  });
});

test("a kept row protects only the process with that start, not a later one on its pid", () => {
  const { listing } = machine();
  const allowed = signallable(listing, {
    self: daemon,
    spare: new Set(),
    kept: [{ pid: 200, start: "an-editor-long-gone" }],
  });
  expect(allowed({ pid: 200, start: "orphan" })).toBe(true);
});

test("the walk stops at this run's daemon: what started the daemon spares nothing below it", () => {
  // This daemon was itself started from another daemon's agent shell.
  const { listing } = fakeMachine({
    40: { parent: 1, start: "outer-daemon", argv: ["node", "/r/ace.mjs", "start"] },
    100: { parent: 40, start: "daemon" },
    200: { parent: 100, start: "provider", env: marked },
  });
  const allowed = signallable(listing, { self: daemon, spare: new Set(), kept: [] });
  expect(allowed({ pid: 200, start: "provider" })).toBe(true);
});

test("ace daemons are told apart from other ace commands by their command line", () => {
  expect(runsAceDaemon(["bun", "--watch", "apps/daemon/src/cli.ts", "start"])).toBe(true);
  expect(runsAceDaemon(["/x/node", "/home/a/.ace/releases/2/ace.mjs", "start"])).toBe(true);
  expect(runsAceDaemon(["/home/a/.ace/bin/ace", "supervise"])).toBe(true);
  expect(runsAceDaemon(["bun", "apps/daemon/src/cli.ts", "--json", "serve"])).toBe(true);
  expect(runsAceDaemon(["bun", "apps/daemon/src/cli.ts", "stop"])).toBe(false);
  expect(runsAceDaemon(["/home/a/.ace/bin/ace", "run", "start the server"])).toBe(false);
  expect(runsAceDaemon(["node", "server.js", "start"])).toBe(false);
});

const receipt = { id: "r", state: "succeeded" as const, at: 1 };

test("ace stop says stopped only when the daemon exited, nothing survived and it saw everything", () => {
  const facts = { receipt, daemon: "exited" as const, survivors: [], complete: true };
  expect(stopVerdict(facts, "/h")).toMatchObject({
    outcome: "ok",
    value: { stopped: true },
  });
  expect(stopVerdict({ ...facts, complete: false }, "/h")).toMatchObject({
    outcome: "uncertain",
  });
  expect(stopVerdict({ ...facts, survivors: [{ pid: 7, start: "s" }] }, "/h")).toMatchObject({
    outcome: "failed",
  });
  expect(stopVerdict({ ...facts, daemon: "running", daemonPid: 9 }, "/h")).toMatchObject({
    outcome: "failed",
    message: expect.stringContaining("still running (pid 9)"),
  });
  expect(stopVerdict({ ...facts, daemon: "unknown" }, "/h")).toMatchObject({
    outcome: "uncertain",
  });
});
