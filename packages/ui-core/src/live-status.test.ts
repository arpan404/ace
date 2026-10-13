import { ThreadRunMetadata, type ThreadStatus } from "@ace/protocol";
import { expect, test } from "vitest";
import { listTreeFacts, treeInBackground, treeWorking } from "./live-status.ts";

const listed = (status: ThreadStatus, live?: Record<string, unknown>) =>
  treeWorking(listTreeFacts({ status, live: live && ThreadRunMetadata.parse(live) }));

test("a listed thread whose root waits on its own running subagents reads as working", () => {
  expect(listed({ state: "working", agents: 3 }, { waitingOn: 2 })).toBe(true);
});

test("a listed thread whose turn ended with a background command reads Background, not working", () => {
  const facts = listTreeFacts({
    status: { state: "waiting", on: "background_task" },
    live: ThreadRunMetadata.parse({ watching: [{ id: "relay", title: "bun run dev:relay" }] }),
  });
  expect(treeWorking(facts)).toBe(false);
  expect(treeInBackground(facts)).toBe(true);
  // A subagent still running is agent work: Working, not Background.
  const tree = listTreeFacts({
    status: { state: "waiting", on: "background_task" },
    live: ThreadRunMetadata.parse({ runningSubagentCount: 1, backgroundTaskCount: 1 }),
  });
  expect(treeWorking(tree)).toBe(true);
  expect(treeInBackground(tree)).toBe(false);
});

test("subagents still running keep a thread working while queued input waits", () => {
  expect(listed({ state: "waiting", on: "queue" }, { runningSubagentCount: 1 })).toBe(true);
  expect(listed({ state: "waiting", on: "queue" })).toBe(false);
});

test("a request waiting on the person outranks running work", () => {
  expect(
    treeWorking({ needsYou: true, root: "working", subagents: 2, backgroundCommands: 1 }),
  ).toBe(false);
});

test("a root held by a usage limit or the network reads as working while its subagents run", () => {
  expect(listed({ state: "limited" }, { runningSubagentCount: 2 })).toBe(true);
  expect(listed({ state: "waiting", on: "network" }, { runningSubagentCount: 2 })).toBe(true);
  // The daemon reports a thread working while any agent in it works, held root or not.
  expect(listed({ state: "working", agents: 2 }, { runningSubagentCount: 1 })).toBe(true);
});

test("a held root with nothing else running says it is held", () => {
  expect(listed({ state: "limited" })).toBe(false);
  expect(listed({ state: "waiting", on: "rate_limit" })).toBe(false);
});

test("a finished turn whose subagents still run is never done", () => {
  expect(treeWorking({ needsYou: false, root: "idle", subagents: 1, backgroundCommands: 0 })).toBe(
    true,
  );
  expect(treeWorking({ needsYou: false, root: "idle", subagents: 0, backgroundCommands: 0 })).toBe(
    false,
  );
});
