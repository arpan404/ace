import { expect, test } from "vitest";
import { scopeListeners, unexplainedPids, type ScopeFacts } from "./scope.ts";

const daemon = 100;
/** A machine: the daemon, a terminal shell for thread A, and processes around them. */
function facts(overrides: Partial<ScopeFacts> = {}): ScopeFacts {
  return {
    daemon,
    daemonPorts: new Set([7000]),
    // 200: thread A's terminal shell; 201 its child; 202 a grandchild.
    // 300: a provider CLI the daemon runs; 301 a shell the agent started.
    // 500: some other process on the machine.
    parents: new Map([
      [100, 1],
      [200, 100],
      [201, 200],
      [202, 201],
      [300, 100],
      [301, 300],
      [500, 1],
      [501, 1],
    ]),
    cwds: new Map(),
    scopes: [
      { threadId: "a", roots: ["/work/app", "/work/app-worktree"], shells: [200] },
      { threadId: "b", roots: ["/work/other"], shells: [] },
    ],
    listeners: [],
    ...overrides,
  };
}
const ports = (result: Map<string, { port: number }[]>, threadId: string) =>
  (result.get(threadId) ?? []).map((listener) => listener.port);

test("a server started from a thread's terminal belongs to that thread wherever it runs", () => {
  const result = scopeListeners(
    facts({
      listeners: [
        { pid: 202, port: 5173, reach: "loopback" },
        { pid: 201, port: 3000, reach: "any" },
      ],
      cwds: new Map([[202, "/somewhere/else"]]),
    }),
  );
  expect(ports(result, "a")).toEqual([5173, 3000]);
  expect(ports(result, "b")).toEqual([]);
});

test("a server running in a thread's project or worktree belongs to it, a sibling directory does not", () => {
  const result = scopeListeners(
    facts({
      listeners: [
        { pid: 301, port: 4000, reach: "loopback" },
        { pid: 500, port: 4001, reach: "loopback" },
        { pid: 501, port: 4002, reach: "loopback" },
      ],
      cwds: new Map([
        [301, "/work/app-worktree/web"],
        [500, "/work/app"],
        [501, "/work/app-other"],
      ]),
    }),
  );
  expect(ports(result, "a")).toEqual([4000, 4001]);
});

test("unrelated listeners, the daemon's own and its direct helpers are never a thread's", () => {
  const result = scopeListeners(
    facts({
      listeners: [
        // The daemon's own API and a port it serves.
        { pid: daemon, port: 8787, reach: "loopback" },
        { pid: 501, port: 7000, reach: "loopback" },
        // A provider CLI listening from inside the project.
        { pid: 300, port: 9229, reach: "loopback" },
        // A database elsewhere on the machine.
        { pid: 500, port: 5432, reach: "any" },
        // A terminal server bound only to a LAN address can't be reached over loopback.
        { pid: 201, port: 9000, reach: "other" },
      ],
      cwds: new Map([
        [300, "/work/app"],
        [500, "/var/lib/postgres"],
        [501, "/work/app"],
      ]),
    }),
  );
  expect(ports(result, "a")).toEqual([]);
  expect(ports(result, "b")).toEqual([]);
});

test("only listeners no terminal explains need their directory looked up", () => {
  expect(
    unexplainedPids(
      facts({
        listeners: [
          { pid: 202, port: 5173, reach: "loopback" },
          { pid: 301, port: 4000, reach: "loopback" },
          { pid: 500, port: 5432, reach: "any" },
          { pid: 300, port: 9229, reach: "loopback" },
          { pid: 500, port: 5433, reach: "any" },
        ],
      }),
    ).toSorted(),
  ).toEqual([301, 500]);
});

test("one port shared by several processes of a thread is suggested once", () => {
  const result = scopeListeners(
    facts({
      listeners: [
        { pid: 201, port: 3000, reach: "any" },
        { pid: 202, port: 3000, reach: "any" },
      ],
    }),
  );
  expect(ports(result, "a")).toEqual([3000]);
});
