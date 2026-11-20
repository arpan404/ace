import { expect, test } from "vitest";
import {
  linuxListing,
  parseCgroupPath,
  parseChildList,
  parseLinuxStat,
  parseProcArgs2,
  type ProcFs,
} from "./process-listing.ts";
import {
  PROCESS_OWNER_ENV,
  carriesOwner,
  claimProcessOwner,
  markedEnv,
  markedProcesses,
} from "./process-marker.ts";
import { provenAdoptions, type ZombieChild } from "./process-reaper.ts";
import { captureTree, treeIo } from "./process-tree.ts";
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
  const fields = Array.from({ length: 19 }, (_, index) => String(index));
  expect(parseLinuxStat(`42 (a (weird) name) Z 7 42 ${fields.join(" ")} 99 1`)).toMatchObject({
    state: "Z",
    ppid: 7,
    group: 42,
  });
  expect(() => parseLinuxStat("42 (short) S 1")).toThrow();
  expect(parseCgroupPath("0::/user.slice/user@1000.service/app.slice/ace-next.service\n")).toBe(
    "/user.slice/user@1000.service/app.slice/ace-next.service",
  );
  expect(parseCgroupPath("12:pids:/legacy\n")).toBeUndefined();
});

/** A /proc stat line for `pid` under `parent`, starting at tick `<pid>0`. */
const fakeStat = (pid: number, parent: number) =>
  `${pid} (p) S ${parent} ${pid} ${Array.from({ length: 17 }, () => "0").join(" ")} ${pid}0 0`;

/** A /proc with `parents` (pid → parent), no per-task child lists, counting table reads. */
function procWithoutChildLists(parents: Record<number, number>) {
  let tableReads = 0;
  const proc: ProcFs = {
    list(path) {
      if (path === "/proc") {
        tableReads++;
        return Object.keys(parents);
      }
      const task = /^\/proc\/(\d+)\/task$/.exec(path);
      return task && parents[Number(task[1])] !== undefined ? [task[1] ?? ""] : undefined;
    },
    read(path) {
      if (path === "/proc/sys/kernel/random/boot_id")
        return Buffer.from("0b9e2c4c-7f3a-4c1e-9a55-2f1d8e6b7a10\n");
      const match = /^\/proc\/(\d+)\/stat$/.exec(path);
      const pid = Number(match?.[1]);
      const parent = parents[pid];
      return match && parent !== undefined ? Buffer.from(fakeStat(pid, parent)) : undefined;
    },
  };
  return { proc, reads: () => tableReads };
}

test("a Linux walk without per-task child lists reads the process table once, not per parent", () => {
  // A chain 100 → 101 → … → 160, plus unrelated processes: many parents to visit.
  const parents: Record<number, number> = { 100: 1 };
  for (let pid = 101; pid <= 160; pid++) parents[pid] = pid - 1;
  for (let pid = 900; pid < 1_000; pid++) parents[pid] = 1;
  const { proc, reads } = procWithoutChildLists(parents);
  const listing = linuxListing(proc);
  const capture = captureTree([100], { ...treeIo(listing), pidfd: undefined });
  expect(capture.members.map((member) => member.pid)).toEqual(
    Array.from({ length: 60 }, (_, index) => 101 + index),
  );
  expect(reads()).toBe(1);
});

test("only zombies proven adopted are reaped, never the daemon's own children", () => {
  const daemon = { pid: 100, group: 100 };
  const zombies: ZombieChild[] = [
    // Seen earlier, with this start, as an app-server's child: adopted when the app-server exited.
    { pid: 301, group: 301, start: "shell" },
    // In a provider's group, which no process the daemon spawned starts in.
    { pid: 302, group: 200, start: "grandchild" },
    // The daemon's own detached spawn (an editor launcher): its own group, never seen.
    { pid: 303, group: 303, start: "launcher" },
    // A plain spawn (git): the daemon's group.
    { pid: 304, group: 100, start: "git" },
    // The runtime's own child, on a pid the watch once saw under another parent.
    { pid: 305, group: 305, start: "bun-child" },
    // An owned group's leader: the runtime reaps it.
    { pid: 200, group: 200, start: "app-server" },
  ];
  const evidence = new Map([
    [301, { start: "shell", parent: 200 }],
    [305, { start: "an-earlier-process", parent: 200 }],
    [200, { start: "app-server", parent: 50 }],
  ]);
  expect(provenAdoptions(zombies, daemon, new Set([200]), evidence)).toEqual([301, 302]);
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

test("the watch forgets processes that ended or whose pid was reused, so it keeps learning", () => {
  const machine = fakeMachine({
    200: { parent: 100, start: "leader", group: 200 },
    300: { parent: 200, start: "first", group: 300 },
    301: { parent: 200, start: "second", group: 301 },
  });
  // Room for two: what it remembers about ended processes must not use it up.
  const watch = new ProcessWatch({
    tree: machine.tree,
    leaders: () => [200],
    schedule: () => () => {},
    knownLimit: 2,
  });
  watch.tick();
  machine.end(300);
  machine.end(301);
  // 300's pid goes to a stranger; a new orphan-to-be, 302, starts under the leader.
  machine.table.set(300, { parent: 1, start: "stranger" });
  watch.tick();
  machine.table.set(302, { parent: 200, start: "third", group: 302 });
  watch.tick();
  machine.end(200);
  watch.tick();
  // The stranger is never taken for the old 300; the new orphan is still known.
  expect(watch.members()).toEqual([{ pid: 302, start: "third" }]);
});

/** A watch over `machine` with the daemon (pid 100) as a subreaper, recording what it reaps. */
function reapingWatch(machine: ReturnType<typeof fakeMachine>, leaders: () => number[]) {
  const reaped: number[] = [];
  const watch = new ProcessWatch({
    tree: machine.tree,
    leaders,
    schedule: () => () => {},
    reaper: {
      self: { pid: 100, group: 100 },
      zombies: () =>
        [...machine.table]
          .filter(([, row]) => row.parent === 100 && row.zombie)
          .map(([pid, row]) => ({ pid, group: row.group ?? 100, start: row.start })),
      reap(pid) {
        reaped.push(pid);
        machine.table.delete(pid);
        return true;
      },
    },
  });
  return { watch, reaped };
}

test("the watch reaps an adopted zombie once, through the proof it saw", () => {
  const machine = fakeMachine({
    200: { parent: 100, start: "app-server", group: 200 },
    300: { parent: 200, start: "shell", group: 300 },
  });
  const { watch, reaped } = reapingWatch(machine, () => [200]);
  watch.tick();
  // The app-server's shell is adopted by the daemon (a subreaper) and exits.
  const shell = machine.table.get(300);
  if (shell) Object.assign(shell, { parent: 100, zombie: true });
  watch.tick();
  watch.tick();
  expect(reaped).toEqual([300]);
});

test("the watch never reaps the runtime's own child that reused a watched pid", () => {
  const machine = fakeMachine({
    200: { parent: 100, start: "app-server", group: 200 },
    300: { parent: 200, start: "shell", group: 200 },
  });
  const { watch, reaped } = reapingWatch(machine, () => [200]);
  watch.tick();
  // The shell exits and its own parent reaps it; later the runtime spawns a child (detached,
  // its own group) on the same pid, which exits and waits for the runtime to reap it.
  machine.end(300);
  machine.table.set(300, { parent: 100, start: "bun-child", group: 300, zombie: true });
  watch.tick();
  expect(reaped).toEqual([]);
  // Nor once the stale record would have aged: no tick ever takes it for the old shell.
  watch.tick();
  expect(reaped).toEqual([]);
  expect(machine.table.get(300)?.start).toBe("bun-child");
});
