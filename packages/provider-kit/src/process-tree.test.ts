import { expect, test } from "vitest";
import { captureDescendants, parseProcessParents, stopMembers } from "./process-tree.ts";
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
  expect(captureDescendants([100], tree)).toEqual([
    { pid: 200, start: "app-server", parent: 100, group: 200 },
    { pid: 300, start: "detached", parent: 200, group: 300 },
    { pid: 301, start: "detached-child", parent: 300, group: 300 },
  ]);
});

test("trees are not read by parent pid on Windows, whose jobs contain them", () => {
  const { tree } = fakeMachine({
    100: { parent: 1, start: "a" },
    200: { parent: 100, start: "b" },
  });
  expect(captureDescendants([100], { ...tree, platform: "win32" })).toEqual([]);
});

test("a stop never signals a pid that another process holds by then", async () => {
  const { tree, table, signals } = fakeMachine({
    200: { parent: 1, start: "captured" },
    300: { parent: 1, start: "captured-too" },
  });
  const members = captureDescendants([1], tree);
  // 300 exited and its pid went to an unrelated process.
  table.set(300, { parent: 1, start: "someone-else" });
  expect(await stopMembers(members, 500, tree)).toEqual([]);
  expect(signals).toEqual(["SIGTERM 200"]);
  expect(table.has(300)).toBe(true);
});

test("a member that ignores SIGTERM is killed, and one that outlives SIGKILL is reported", async () => {
  const { tree, signals } = fakeMachine({
    200: { parent: 1, start: "stubborn", ignores: "TERM" },
    300: { parent: 1, start: "unkillable", ignores: "all" },
  });
  const survivors = await stopMembers(captureDescendants([1], tree), 500, tree);
  expect(survivors.map((member) => member.pid)).toEqual([300]);
  expect(signals).toEqual(["SIGTERM 200", "SIGTERM 300", "SIGKILL 200", "SIGKILL 300"]);
});

test("a zombie counts as stopped: it has exited, only its exit status is left", async () => {
  const { tree, signals } = fakeMachine({ 200: { parent: 1, start: "done", zombie: true } });
  expect(await stopMembers([{ pid: 200, start: "done" }], 500, tree)).toEqual([]);
  expect(signals).toEqual([]);
});
