import { expect, test } from "vitest";
import { pidfdFailure } from "./process-signal.ts";
import { captureTree, parseProcessParents, stopMembers } from "./process-tree.ts";
import { fakeMachine } from "./process-tree-test-support.ts";

test("process parents survive malformed rows", () => {
  expect([...parseProcessParents("    1     0\n  326     1\n garbage\n  400   326\n")]).toEqual([
    [1, 0],
    [326, 1],
    [400, 326],
  ]);
});

test("a tree includes grandchildren, wherever their process group is, and nothing else", () => {
  const { tree } = fakeMachine({
    1: { parent: 0, start: "init" },
    100: { parent: 1, start: "daemon" },
    200: { parent: 100, start: "app-server", group: 200 },
    // Started by the app-server in a session of its own: no group signal reaches it.
    300: { parent: 200, start: "detached", group: 300 },
    301: { parent: 300, start: "detached-child" },
    // Another home's daemon and its child.
    900: { parent: 1, start: "other-daemon" },
    901: { parent: 900, start: "other-child" },
  });
  expect(captureTree([100], tree)).toEqual({
    truncated: false,
    members: [
      { pid: 200, start: "app-server", parent: 100, group: 200 },
      { pid: 300, start: "detached", parent: 200, group: 300 },
      { pid: 301, start: "detached-child", parent: 300, group: 300 },
    ],
  });
});

test("trees are not read by parent pid on Windows, whose jobs contain them", () => {
  const { tree } = fakeMachine({
    100: { parent: 1, start: "a" },
    200: { parent: 100, start: "b" },
  });
  expect(captureTree([100], { ...tree, platform: "win32" }).members).toEqual([]);
});

test("a child whose pid is reused before its identity is read is not taken for a member", () => {
  const machine = fakeMachine(
    {
      100: { parent: 1, start: "daemon" },
      200: { parent: 100, start: "app-server" },
    },
    {
      beforeIdentity(pid) {
        // Between the child list and the identity read, 200 exits and a stranger takes its pid.
        if (pid === 200 && machine.table.get(200)?.start === "app-server") {
          machine.end(200);
          machine.table.set(200, { parent: 1, start: "stranger" });
        }
      },
    },
  );
  expect(captureTree([100], machine.tree).members).toEqual([]);
});

test("children listed under a parent pid that was reused meanwhile are dropped", () => {
  let listed = false;
  const machine = fakeMachine(
    {
      100: { parent: 1, start: "daemon" },
      200: { parent: 100, start: "app-server" },
    },
    {
      beforeIdentity(pid) {
        // The app-server exits after its children were listed, and a stranger reuses its pid
        // with a child of its own that the list already named.
        if (pid === 300 && !listed) {
          listed = true;
          machine.end(200);
          machine.table.set(200, { parent: 1, start: "stranger" });
          machine.table.set(300, { parent: 200, start: "stranger-child" });
        }
      },
    },
  );
  machine.table.set(300, { parent: 200, start: "shell" });
  // The app-server was the daemon's child when read; nothing the reused pid listed is kept.
  expect(captureTree([100], machine.tree).members.map((member) => member.start)).toEqual([
    "app-server",
  ]);
});

test("a capture that reaches its limit says it is truncated", () => {
  const { tree } = fakeMachine({
    100: { parent: 1, start: "daemon" },
    200: { parent: 100, start: "a" },
    201: { parent: 100, start: "b" },
    202: { parent: 100, start: "c" },
  });
  const capture = captureTree([100], tree, 2);
  expect(capture.truncated).toBe(true);
  expect(capture.members).toHaveLength(2);
  expect(captureTree([100], tree, 3).truncated).toBe(false);
});

test("a stop checks each member just before its signal, so a pid reused mid-batch is spared", async () => {
  const machine = fakeMachine(
    {
      200: { parent: 1, start: "first" },
      300: { parent: 1, start: "second" },
    },
    {
      afterSignal(pid) {
        // While the batch runs, 300 exits and its pid goes to an unrelated process.
        if (pid === 200 && machine.table.get(300)?.start === "second") {
          machine.end(300);
          machine.table.set(300, { parent: 1, start: "stranger" });
        }
      },
    },
  );
  await stopMembers(
    [
      { pid: 200, start: "first" },
      { pid: 300, start: "second" },
    ],
    500,
    machine.tree,
  );
  expect(machine.signals).toEqual(["SIGTERM 200:first"]);
  expect(machine.table.get(300)?.start).toBe("stranger");
});

/**
 * A machine where pid 300's process exits and a stranger takes its pid right after the third
 * identity read of 300 (the stop's liveness check, the check before a pidfd opens, the check
 * after): the last check before its signal, whichever path signals it.
 */
function reusedAtTheSignal() {
  let reads = 0;
  const machine = fakeMachine(
    { 300: { parent: 1, start: "second" } },
    {
      afterIdentity(pid) {
        if (pid !== 300 || ++reads !== 3) return;
        machine.end(300);
        machine.table.set(300, { parent: 1, start: "stranger" });
      },
    },
  );
  return machine;
}

test("with pidfds, a pid reused between the last check and the signal is never signalled", async () => {
  const machine = reusedAtTheSignal();
  await stopMembers([{ pid: 300, start: "second" }], 500, {
    ...machine.tree,
    pidfd: machine.pidfd,
  });
  // The pidfd pinned the process that was checked; it had gone, so the signal reached nobody.
  expect(machine.signals).toEqual([]);
  expect(machine.table.get(300)?.start).toBe("stranger");
});

test("a pidfd that can't be opened for lack of descriptors never falls back to the bare pid", async () => {
  const machine = fakeMachine(
    { 300: { parent: 1, start: "provider" } },
    { openFailure: () => "unsafe" },
  );
  const left = await stopMembers([{ pid: 300, start: "provider" }], 500, {
    ...machine.tree,
    pidfd: machine.pidfd,
  });
  // Not signalled at all, and reported as still running.
  expect(machine.signals).toEqual([]);
  expect(left).toEqual([{ pid: 300, start: "provider" }]);
});

test("a kernel without pidfds is the one case where the pid is signalled directly", async () => {
  const machine = fakeMachine(
    { 300: { parent: 1, start: "provider" } },
    { openFailure: () => "unsupported" },
  );
  const left = await stopMembers([{ pid: 300, start: "provider" }], 500, {
    ...machine.tree,
    pidfd: machine.pidfd,
  });
  expect(left).toEqual([]);
  expect(machine.signals).toEqual(["SIGTERM 300:provider"]);
});

test("pidfd_open errors are told apart: gone, unsupported, or unsafe", () => {
  expect(pidfdFailure(3)).toEqual({ error: "gone" });
  expect(pidfdFailure(38)).toEqual({ error: "unsupported" });
  // EMFILE, ENFILE, ENOMEM, and anything unknown.
  for (const errno of [24, 23, 12, -1]) expect(pidfdFailure(errno)).toEqual({ error: "unsafe" });
});

test("a stop past its deadline sends no signal and reports what still runs", async () => {
  const machine = fakeMachine({ 300: { parent: 1, start: "provider" } });
  const left = await stopMembers(
    [{ pid: 300, start: "provider" }],
    500,
    machine.tree,
    performance.now() - 1,
  );
  expect(machine.signals).toEqual([]);
  expect(left).toEqual([{ pid: 300, start: "provider" }]);
});

test("a member that ignores SIGTERM is killed, and one that outlives SIGKILL is reported", async () => {
  const { tree, signals } = fakeMachine({
    200: { parent: 1, start: "stubborn", ignores: "TERM" },
    300: { parent: 1, start: "unkillable", ignores: "all" },
  });
  const members = [
    { pid: 200, start: "stubborn" },
    { pid: 300, start: "unkillable" },
  ];
  const survivors = await stopMembers(members, 500, tree);
  expect(survivors.map((member) => member.pid)).toEqual([300]);
  expect(signals).toEqual([
    "SIGTERM 200:stubborn",
    "SIGTERM 300:unkillable",
    "SIGKILL 200:stubborn",
    "SIGKILL 300:unkillable",
  ]);
});

test("a zombie counts as stopped: it has exited, only its exit status is left", async () => {
  const { tree, signals } = fakeMachine({ 200: { parent: 1, start: "done", zombie: true } });
  expect(await stopMembers([{ pid: 200, start: "done" }], 500, tree)).toEqual([]);
  expect(signals).toEqual([]);
});
