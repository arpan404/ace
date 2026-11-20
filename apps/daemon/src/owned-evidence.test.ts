import { expect, test } from "vitest";
import { fakeMachine } from "@ace/provider-kit/process-tree-test-support";
import { signallable } from "./owned-evidence.ts";
import { stopVerdict } from "./cli/daemon-stop.ts";
import { parseLsofTcp, parseProcTcp, verifiedCaller, type PeerIo } from "./peer-process.ts";

const run = "0b9e2c4c-7f3a-4c1e-9a55-2f1d8e6b7a10";
const marked = [`ACE_PROCESS_OWNER=${run}`];
const daemon = { pid: 100, start: "daemon" };

/** This run's daemon (100) under a terminal (50), and what the cases put around it. */
function machine() {
  return fakeMachine({
    50: { parent: 1, start: "terminal" },
    100: { parent: 50, start: "daemon" },
    // A marked orphan of this run's: the one candidate the rules let through.
    200: { parent: 1, start: "orphan", env: marked },
    // The updater ace recorded as it launched it, and a helper it started.
    300: { parent: 100, start: "updater", env: ["ACE_PROCESS_KEEP=1"] },
    301: { parent: 300, start: "installer", env: marked },
    // A provider helper that only claims to be kept: the variable alone proves nothing.
    310: { parent: 1, start: "claims-kept", env: [...marked, "ACE_PROCESS_KEEP=1"] },
    // A provider helper that only looks like a daemon by its command line.
    320: {
      parent: 1,
      start: "looks-like-a-daemon",
      env: marked,
      argv: ["/usr/local/bin/node", "/x/releases/1/ace.mjs", "start"],
    },
    // Home B's daemon, started from this run's agent shell: it carries this run's marker, and its
    // home's run marker names its pid and start.
    400: { parent: 1, start: "home-b-daemon", env: [...marked, "ACE_HOME=/homes/b"] },
    401: { parent: 400, start: "home-b-provider", env: marked },
    // A process on a pid home C's marker names, but with another start: not that daemon.
    500: { parent: 1, start: "reused-pid", env: [...marked, "HOME=/people/c"] },
    // `ace stop` run from this run's provider shell, and that shell.
    600: { parent: 100, start: "provider-shell", env: marked },
    601: { parent: 600, start: "ace-stop", env: marked },
  });
}

const markers: Record<string, unknown> = {
  "/homes/b": { state: "running", pid: 400, startedAt: 1, start: "home-b-daemon" },
  // Home C is the default home of a person whose HOME is /people/c.
  "/people/c/.ace": { state: "running", pid: 500, startedAt: 1, start: "home-c-daemon" },
};

test("a sweep signals only candidates no proven protection covers", () => {
  const { listing } = machine();
  const allowed = signallable(listing, {
    self: daemon,
    spare: new Set([600, 601]),
    kept: [{ pid: 300, start: "updater" }],
    readMarker: (home) => markers[home],
  });
  const verdicts = Object.fromEntries(
    listing.all().map((pid) => {
      const info = listing.info(pid);
      return [pid, info ? allowed({ pid, start: info.start }) : false];
    }),
  );
  expect(verdicts).toMatchObject({
    200: true,
    // Kept by ace's own record, and its helper for being below it.
    300: false,
    301: false,
    // The variable and the command line prove nothing.
    310: true,
    320: true,
    // Home B's daemon, by its home's marker naming its pid AND start, and all below it.
    400: false,
    401: false,
    // Home C's marker names pid 500, but another process: no protection.
    500: true,
    // The stop's caller chain.
    600: false,
    601: false,
  });
});

test("a kept record protects only the process with that start, not a later one on its pid", () => {
  const { listing } = machine();
  const allowed = signallable(listing, {
    self: daemon,
    spare: new Set(),
    kept: [{ pid: 200, start: "an-editor-long-gone" }],
  });
  expect(allowed({ pid: 200, start: "orphan" })).toBe(true);
});

test("the walk stops at this run's daemon: what started the daemon spares nothing below it", () => {
  // This daemon was itself started from another home's daemon's agent shell.
  const { listing } = fakeMachine({
    40: { parent: 1, start: "outer-daemon", env: ["ACE_HOME=/homes/outer"] },
    100: { parent: 40, start: "daemon" },
    200: { parent: 100, start: "provider", env: marked },
  });
  const allowed = signallable(listing, {
    self: daemon,
    spare: new Set(),
    kept: [],
    readMarker: (home) =>
      home === "/homes/outer"
        ? { state: "running", pid: 40, startedAt: 1, start: "outer-daemon" }
        : undefined,
  });
  expect(allowed({ pid: 200, start: "provider" })).toBe(true);
});

/** The CLI (700) under its shell (600) under the daemon (100): what the daemon can verify. */
function caller(holds: boolean) {
  const { listing } = fakeMachine({
    100: { parent: 1, start: "daemon" },
    600: { parent: 100, start: "provider-shell" },
    700: { parent: 600, start: "ace-stop" },
  });
  // Linux's view: 700 holds the client end of the connection (client port 50000 → 47811).
  const io: PeerIo = {
    platform: "linux",
    read: (path) =>
      path === "/proc/700/net/tcp"
        ? "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n" +
          "   0: 0100007F:C350 0100007F:BAC3 01 00000000:00000000 00:00000000 00000000   501        0 4242 1\n"
        : undefined,
    list: (path) => (path === "/proc/700/fd" ? ["0", "1", "7"] : undefined),
    link: (path) => (holds && path === "/proc/700/fd/7" ? "socket:[4242]" : "/dev/null"),
    lsof: async () => undefined,
  };
  return { listing, io, connection: { remotePort: 50_000, localPort: 47_811 } };
}

const chain = [
  { pid: 700, start: "ace-stop" },
  { pid: 600, start: "provider-shell" },
  { pid: 100, start: "daemon" },
];

test("a stop's caller chain is spared only when it really holds the request's connection", async () => {
  const held = caller(true);
  expect(await verifiedCaller(chain, held.connection, held.listing, held.io)).toEqual(chain);
  // Another process claims the chain: it holds no socket of this connection.
  const claimed = caller(false);
  expect(await verifiedCaller(chain, claimed.connection, claimed.listing, claimed.io)).toEqual([]);
});

test("a caller chain that doesn't match the real ancestry spares nothing", async () => {
  const { listing, io, connection } = caller(true);
  // The right caller, but its claimed ancestors aren't its real ones.
  const forged = [chain[0] ?? daemon, { pid: 900, start: "someone-to-protect" }];
  expect(await verifiedCaller(forged, connection, listing, io)).toEqual([]);
  expect(await verifiedCaller(undefined, connection, listing, io)).toEqual([]);
});

test("TCP connections are read from /proc and lsof", () => {
  expect(
    parseProcTcp(
      "  sl  local_address rem_address st\n" +
        "   0: 0100007F:C350 0100007F:BAA3 01 0:0 0:0 0 501 0 4242 1\n" +
        "   1: 0100007F:1F90 00000000:0000 0A 0:0 0:0 0 501 0 99 1\n",
    ),
  ).toEqual([{ localPort: 50_000, remotePort: 47_779, inode: "4242" }]);
  expect(parseLsofTcp("p700\nf7\nn127.0.0.1:50000->127.0.0.1:47811\nf9\nn*:5000\n")).toEqual([
    { localPort: 50_000, remotePort: 47_811 },
  ]);
});

const receipt = { id: "r", state: "succeeded" as const, at: 1 };

test("ace stop says stopped only when the daemon exited, nothing survived and all was seen", () => {
  const facts = { receipt, daemon: "exited" as const, survivors: [], complete: true };
  expect(stopVerdict(facts, "/h")).toMatchObject({ outcome: "ok", value: { stopped: true } });
  expect(stopVerdict({ ...facts, complete: false }, "/h")).toMatchObject({
    outcome: "uncertain",
  });
  // The daemon itself couldn't account for everything its run started.
  expect(stopVerdict({ ...facts, receipt: { ...receipt, unaccounted: true } }, "/h")).toMatchObject(
    { outcome: "uncertain", message: expect.stringContaining("account for") },
  );
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
