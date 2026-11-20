import { expect, test } from "vitest";
import {
  parseCgroupPath,
  parseChildList,
  parseLinuxStat,
  parseProcArgs2,
} from "./process-listing.ts";
import {
  PROCESS_OWNER_ENV,
  carriesOwner,
  claimProcessOwner,
  markedEnv,
  markedProcesses,
} from "./process-marker.ts";
import { provenAdoptions } from "./process-reaper.ts";
import { ProcessWatch, type WatchJournal } from "./process-watch.ts";
import type { TreeMember } from "./process-tree.ts";
import { fakeMachine } from "./process-tree-test-support.ts";

const run = "0b9e2c4c-7f3a-4c1e-9a55-2f1d8e6b7a10";
const otherRun = "5d1f0a7e-2b3c-4d5e-8f90-a1b2c3d4e5f6";

test("a claimed run marks spawns, and drops a marker the daemon itself inherited", () => {
  const env: NodeJS.ProcessEnv = { PATH: "/bin", [PROCESS_OWNER_ENV]: otherRun };
  const release = claimProcessOwner(run, env);
  try {
    expect(env[PROCESS_OWNER_ENV]).toBeUndefined();
    expect(markedEnv({ PATH: "/bin" })).toEqual({ PATH: "/bin", [PROCESS_OWNER_ENV]: run });
  } finally {
    release();
  }
  expect(markedEnv({ PATH: "/bin" })).toEqual({ PATH: "/bin" });
});

test("a marker matches its own run exactly, never another run, a prefix or an empty id", () => {
  const environment = [`${PROCESS_OWNER_ENV}=${run}`, "HOME=/home/a"];
  expect(carriesOwner(environment, run)).toBe(true);
  expect(carriesOwner(environment, otherRun)).toBe(false);
  expect(carriesOwner(environment, run.slice(0, 20))).toBe(false);
  expect(carriesOwner([`${PROCESS_OWNER_ENV}=`], "")).toBe(false);
  expect(carriesOwner([`${PROCESS_OWNER_ENV}=${run}-extra`], run)).toBe(false);
});

test("the marker sweep finds this run's orphans, not another home's or hidden environments", () => {
  const { listing } = fakeMachine({
    // Orphaned to init: no tree reaches it, its marker does.
    300: { parent: 1, start: "orphan", env: [`${PROCESS_OWNER_ENV}=${run}`] },
    400: { parent: 1, start: "other-home", env: [`${PROCESS_OWNER_ENV}=${otherRun}`] },
    // An Apple platform binary on macOS: its environment is hidden.
    500: { parent: 1, start: "hidden" },
  });
  expect(markedProcesses(run, listing)).toEqual([300]);
});

test("a macOS process's arguments and environment are read from KERN_PROCARGS2", () => {
  const argc = Buffer.alloc(4);
  argc.writeInt32LE(2);
  const bytes = Buffer.concat([
    argc,
    Buffer.from("/usr/local/bin/codex\0\0\0\0codex\0app-server\0A=1\0ACE_PROCESS_OWNER=x\0\0junk"),
  ]);
  expect(parseProcArgs2(bytes)).toEqual({
    argv: ["codex", "app-server"],
    env: ["A=1", "ACE_PROCESS_OWNER=x"],
  });
  // A platform binary: the kernel returns its arguments and no environment.
  expect(
    parseProcArgs2(Buffer.concat([argc, Buffer.from("/bin/sleep\0/bin/sleep\x0030\0")])).env,
  ).toEqual([]);
  expect(parseProcArgs2(Buffer.alloc(2))).toEqual({ argv: [], env: [] });
});

test("Linux children, stat and cgroup files are read leniently", () => {
  expect(parseChildList("12 13  x 14\n")).toEqual([12, 13, 14]);
  expect(parseLinuxStat("42 (a (weird) name) Z 7 42 42 0 -1")).toEqual({
    state: "Z",
    ppid: 7,
    group: 42,
  });
  expect(parseCgroupPath("0::/user.slice/user@1000.service/app.slice/ace-next.service\n")).toBe(
    "/user.slice/user@1000.service/app.slice/ace-next.service",
  );
  expect(parseCgroupPath("12:pids:/legacy\n")).toBeUndefined();
});

test("only zombies proven adopted are reaped, never the daemon's own children", () => {
  const daemon = { pid: 100, group: 100 };
  expect(
    provenAdoptions(
      [
        // Seen earlier as an app-server's child: adopted when the app-server exited.
        { pid: 301, group: 301, seenWithParent: 200 },
        // In a provider's group, which no process the daemon spawned starts in.
        { pid: 302, group: 200 },
        // The daemon's own detached spawn (an editor launcher): its own group, never seen.
        { pid: 303, group: 303 },
        // A plain spawn (git): the daemon's group.
        { pid: 304, group: 100 },
        // An owned group's leader: the runtime reaps it.
        { pid: 200, group: 200, seenWithParent: 50 },
      ],
      daemon,
      new Set([200]),
    ),
  ).toEqual([301, 302]);
});

function journal() {
  const rows = new Map<number, string>();
  const io: WatchJournal = {
    record: (members: readonly TreeMember[]) => {
      for (const member of members) rows.set(member.pid, member.start);
    },
    forget: (members: readonly TreeMember[]) => {
      for (const member of members) rows.delete(member.pid);
    },
  };
  return { io, rows };
}

test("the watch keeps an orphan it saw while its parent lived, and journals it", () => {
  const machine = fakeMachine({
    200: { parent: 100, start: "probe", group: 200 },
    // A platform binary in a session of its own: no marker shows, no group signal reaches it.
    300: { parent: 200, start: "sleep", group: 300 },
  });
  const book = journal();
  const watch = new ProcessWatch({
    tree: machine.tree,
    leaders: () => (machine.table.has(200) ? [200] : []),
    schedule: () => () => {},
    journal: book.io,
  });
  expect(watch.tick()).toBe(true);
  // Outside the probe's group already: recorded for the next start.
  expect([...book.rows]).toEqual([[300, "sleep"]]);
  machine.end(200);
  // Its parent is gone and it belongs to init; the watch still knows it.
  expect(watch.tick()).toBe(true);
  expect(watch.members()).toEqual([{ pid: 300, start: "sleep" }]);
  machine.end(300);
  expect(watch.tick()).toBe(false);
  expect(watch.members()).toEqual([]);
  expect(book.rows.size).toBe(0);
});

test("the watch forgets a reused pid's earlier process", () => {
  const machine = fakeMachine({
    200: { parent: 100, start: "leader", group: 200 },
    300: { parent: 200, start: "first", group: 300 },
  });
  const watch = new ProcessWatch({
    tree: machine.tree,
    leaders: () => [200],
    schedule: () => () => {},
  });
  watch.tick();
  machine.end(300);
  machine.table.set(300, { parent: 1, start: "stranger" });
  watch.tick();
  expect(watch.members()).toEqual([]);
});

test("the watch reaps an adopted zombie once, through the proof it saw", () => {
  const machine = fakeMachine({
    200: { parent: 100, start: "app-server", group: 200 },
    300: { parent: 200, start: "shell", group: 300 },
  });
  const reaped: number[] = [];
  const watch = new ProcessWatch({
    tree: machine.tree,
    leaders: () => [200],
    schedule: () => () => {},
    reaper: {
      self: { pid: 100, group: 100 },
      zombies: () =>
        [...machine.table]
          .filter(([, row]) => row.parent === 100 && row.zombie)
          .map(([pid]) => ({ pid, group: 300 })),
      reap(pid) {
        reaped.push(pid);
        machine.table.delete(pid);
        return true;
      },
    },
  });
  watch.tick();
  // The app-server's shell is adopted by the daemon (a subreaper) and exits.
  const shell = machine.table.get(300);
  if (shell) Object.assign(shell, { parent: 100, zombie: true });
  watch.tick();
  watch.tick();
  expect(reaped).toEqual([300]);
});
