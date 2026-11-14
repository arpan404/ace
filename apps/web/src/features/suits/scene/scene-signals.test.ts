import type { ThreadListEntry, ThreadStatus } from "@ace/protocol";
import { expect, test } from "vitest";
import { sceneSignals, signalSnapshot, type SignalSnapshot } from "./scene-signals.ts";

type State = ThreadStatus["state"];
type PrState = "open" | "draft" | "merged" | "closed";

const statusOf: Record<State, ThreadStatus> = {
  needs_you: { state: "needs_you", interactions: 1 },
  working: { state: "working", agents: 1 },
  waiting: { state: "waiting", on: "background_task" },
  limited: { state: "limited" },
  failed: { state: "failed" },
  unresponsive: { state: "unresponsive" },
  done: { state: "done" },
  new: { state: "new" },
};

function thread(id: string, state: State, prs: Record<string, PrState> = {}): ThreadListEntry {
  const entry = {
    id,
    workspaceId: "w",
    title: `Secret title of ${id}`,
    provider: "codex",
    status: statusOf[state],
    createdAt: 1,
    updatedAt: 1,
    details: {
      linkedPrs: Object.entries(prs).map(([url, prState], index) => ({
        number: index + 1,
        repo: { forge: "github", host: "github.com", owner: "o", name: "r" },
        url,
        state: prState,
        updatedAt: 1,
      })),
    },
  };
  return entry as ThreadListEntry;
}

const list = (...threads: ThreadListEntry[]): SignalSnapshot => signalSnapshot(threads);
const empty = list();

test("a thread moving into working, needs-you, done or failed signals it", () => {
  const before = list(
    thread("a", "new"),
    thread("b", "working"),
    thread("c", "working"),
    thread("d", "working"),
  );
  const after = list(
    thread("a", "working"),
    thread("b", "needs_you"),
    thread("c", "done"),
    thread("d", "failed"),
  );
  expect(sceneSignals(before, after)).toEqual(["working", "waiting", "done", "failed"]);
});

test("the first snapshot and threads that arrive in their state are not news", () => {
  expect(sceneSignals(empty, list(thread("a", "working"), thread("b", "failed")))).toEqual([]);
  const before = list(thread("a", "working"));
  expect(sceneSignals(before, list(thread("a", "working"), thread("b", "done")))).toEqual([]);
});

test("states with no scene meaning send nothing", () => {
  const before = list(thread("a", "working"));
  for (const state of ["waiting", "limited", "unresponsive", "new"] as const)
    expect(sceneSignals(before, list(thread("a", state)))).toEqual([]);
});

test("many threads making the same change send one signal", () => {
  const before = list(thread("a", "working"), thread("b", "working"));
  expect(sceneSignals(before, list(thread("a", "done"), thread("b", "done")))).toEqual(["done"]);
});

test("a linked pull request that becomes merged signals pr-merged once", () => {
  const url = "https://github.com/o/r/pull/1";
  const before = list(thread("a", "done", { [url]: "open" }));
  const merged = list(thread("a", "done", { [url]: "merged" }));
  expect(sceneSignals(before, merged)).toEqual(["pr-merged"]);
  expect(sceneSignals(merged, merged)).toEqual([]);
});

test("a pull request first seen already merged, or closed unmerged, is not a merge", () => {
  const url = "https://github.com/o/r/pull/2";
  expect(
    sceneSignals(list(thread("a", "done")), list(thread("a", "done", { [url]: "merged" }))),
  ).toEqual([]);
  const open = list(thread("a", "done", { [url]: "open" }));
  expect(sceneSignals(open, list(thread("a", "done", { [url]: "closed" })))).toEqual([]);
});

const isMine = (entry: ThreadListEntry) => entry.id !== "remote";

test("threads left out of the snapshot send nothing", () => {
  const before = signalSnapshot([thread("remote", "working")], isMine);
  const after = signalSnapshot([thread("remote", "failed")], isMine);
  expect(sceneSignals(before, after)).toEqual([]);
});
