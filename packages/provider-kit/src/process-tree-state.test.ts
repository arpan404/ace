import { describe, expect, test } from "vitest";
import { windowsTreeState, type WindowsIdentify } from "./process-identity.ts";

const sid = "S-1-5-21-1-2-3-1001";
const stranger = "S-1-5-21-1-2-3-1002";
const snapshot = (taken: number, processes: [pid: number, parent: number][]) => ({
  taken: String(taken),
  processes: processes.map(([pid, parent]) => ({ pid, parent })),
});
/** Live processes by PID: creation time and owner. Anything else is gone. */
const host =
  (live: Record<number, [start: number, uid?: string] | "unknown">): WindowsIdentify =>
  (pid) => {
    const found = live[pid];
    if (found === undefined) return undefined;
    if (found === "unknown") return "unknown";
    return { start: String(found[0]), uid: found[1] ?? sid };
  };
const record = (pid: number, start: number) => ({ pid, start: String(start), uid: sid });

describe.runIf(process.platform === "win32")("Windows process tree ownership", () => {
  test("a child made by a later process that reused the dead leader's PID is neither ended nor claimed", () => {
    // Leader 100 (started 10) died; a stranger reused 100, made child 200 at 30, then exited.
    const state = windowsTreeState(
      [record(100, 10)],
      snapshot(50, [[200, 100]]),
      host({ 200: [30] }),
    );
    expect(state.live).toEqual([]);
    expect(state.discovered).toEqual([]);
    expect(state.ambiguous).toEqual([200]);
  });

  test("while a reuser of the leader's PID still runs, its own children are strangers and earlier orphans stay unproven", () => {
    // Leader 100 (10) died; 150 was made at 20, before 100 was reused by a process started at 25.
    const state = windowsTreeState(
      [record(100, 10)],
      snapshot(50, [
        [150, 100],
        [200, 100],
      ]),
      host({ 100: [25], 150: [20], 200: [30] }),
    );
    expect(state.live).toEqual([]);
    expect(state.ambiguous).toEqual([150]);
  });

  test("a surviving grandchild whose recorded parent and leader both exited keeps the tree unresolved", () => {
    const state = windowsTreeState(
      [record(100, 10), record(200, 15)],
      snapshot(50, [[300, 200]]),
      host({ 300: [20] }),
    );
    expect(state.live).toEqual([]);
    expect(state.gone.map((member) => member.pid)).toEqual([100, 200]);
    expect(state.ambiguous).toEqual([300]);
  });

  test("a recorded descendant that is still running is ended even after its parents exited", () => {
    const state = windowsTreeState(
      [record(100, 10), record(200, 15), record(300, 20)],
      snapshot(50, [[300, 200]]),
      host({ 300: [20] }),
    );
    expect(state.live).toEqual([record(300, 20)]);
    expect(state.ambiguous).toEqual([]);
  });

  test("only children made by a live proven parent before the snapshot are claimed", () => {
    const state = windowsTreeState(
      [record(100, 10)],
      snapshot(50, [
        [200, 100], // made by 100 at 20: proven
        [300, 200], // made by 200 at 25: proven through 200
        [400, 100], // started at 5, before 100 existed: an earlier holder's child
        [500, 100], // started at 60, after the snapshot: its PID may have been reused since
        [600, 100], // another account's process
      ]),
      host({ 100: [10], 200: [20], 300: [25], 400: [5], 500: [60], 600: [30, stranger] }),
    );
    expect(state.live.map((member) => member.pid)).toEqual([100, 200, 300]);
    expect(state.discovered).toEqual([record(200, 20), record(300, 25)]);
    expect(state.ambiguous).toEqual([]);
  });

  test("a recorded member that cannot be read is neither ended nor counted gone", () => {
    const state = windowsTreeState([record(100, 10)], snapshot(50, []), host({ 100: "unknown" }));
    expect(state.live).toEqual([]);
    expect(state.gone).toEqual([]);
    expect(state.ambiguous).toEqual([100]);
  });
});
