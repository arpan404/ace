import { Item } from "@ace/protocol";
import { expect, test } from "vitest";
import {
  buildBlocks,
  withoutQueued,
  type Block,
  type BlockSource,
  type RunFacts,
} from "./blocks.ts";

/*
 * How the transcript reads: which ask sits above which answer, and how many rows one failure
 * takes. Items are given in the daemon's admission order, with the run each belongs to.
 */

type Entry = { id: string; role?: "user" | "assistant"; run?: string; text?: string };

function source(entries: Entry[], runs: Record<string, RunFacts>): BlockSource {
  const items = new Map<string, Item>(
    entries.map((entry, at) => [
      entry.id,
      Item.parse({
        id: entry.id,
        agentId: "root",
        createdAt: at,
        complete: true,
        raw: [],
        ...(entry.run ? { runId: entry.run } : {}),
        ...(entry.role
          ? { type: "message", role: entry.role, parts: [{ type: "text", text: entry.id }] }
          : { type: "notice", level: "error", text: entry.text ?? entry.id }),
      }),
    ]),
  );
  return {
    order: entries.map((entry) => entry.id),
    item: (id) => items.get(id),
    background: new Map(),
    turnOf: (id) => items.get(id)?.runId,
    run: (id) => runs[id],
  };
}

const ended = (state: RunFacts["state"]): RunFacts => ({ state, trigger: "user", endedAt: 10 });
const shown = (blocks: readonly Block[]) =>
  blocks.map((block) => ("itemId" in block ? block.itemId : `${block.kind}:${block.key}`));

test("a message queued while the agent worked reads after the answer it waited for", () => {
  // The daemon admitted the queued ask while the first turn still worked, so it sits between
  // that turn's commentary and its answer; it was answered by the second turn.
  const blocks = buildBlocks(
    source(
      [
        { id: "hold", role: "user", run: "A" },
        { id: "commentary", role: "assistant", run: "A" },
        { id: "queued", role: "user", run: "B" },
        { id: "hold-done", role: "assistant", run: "A" },
        { id: "queued-done", role: "assistant", run: "B" },
      ],
      { A: ended("completed"), B: ended("completed") },
    ),
  );
  expect(shown(blocks)).toEqual(["hold", "commentary", "hold-done", "queued", "queued-done"]);
});

test("a message steered into the running turn keeps its place", () => {
  const blocks = buildBlocks(
    source(
      [
        { id: "ask", role: "user", run: "A" },
        { id: "working", role: "assistant", run: "A" },
        { id: "steer", role: "user", run: "A" },
        { id: "answer", role: "assistant", run: "A" },
      ],
      { A: ended("completed") },
    ),
  );
  expect(shown(blocks)).toEqual(["ask", "working", "steer", "answer"]);
});

test("a failed turn's error notice is its ending: one row, which knows the notice", () => {
  const blocks = buildBlocks(
    source(
      [
        { id: "ask", role: "user", run: "A" },
        { id: "auth", run: "A", text: "Sign in to Claude Code and retry." },
      ],
      { A: ended("failed") },
    ),
  );
  expect(blocks.map((block) => block.kind)).toEqual(["user", "end"]);
  expect(blocks.at(-1)).toMatchObject({ kind: "end", ending: "failed", errorId: "auth" });
});

test("an error the agent answered after stays its own row; the ending says the turn failed", () => {
  const blocks = buildBlocks(
    source(
      [
        { id: "ask", role: "user", run: "A" },
        { id: "flaky", run: "A", text: "Network trouble, retrying" },
        { id: "recovered", role: "assistant", run: "A" },
      ],
      { A: ended("failed") },
    ),
  );
  expect(blocks.map((block) => block.kind)).toEqual(["user", "item", "message", "end"]);
  expect(blocks.at(-1)).not.toHaveProperty("errorId");
});

test("an ending tied to a message still in the queue goes with it; the turn before is the newest again", () => {
  // The agent failed with a queued message last in line: the transcript ends on that hidden ask.
  const blocks = buildBlocks({
    ...source(
      [
        { id: "ask", role: "user", run: "A" },
        { id: "working", role: "assistant", run: "A" },
        { id: "input:queued", role: "user" },
      ],
      { A: ended("failed") },
    ),
    stoppedTail: "failed",
  });
  expect(blocks.filter((block) => block.kind === "end")).toHaveLength(2);

  const visible = withoutQueued(blocks, [{ id: "queued" }]);
  expect(visible.filter((block) => block.kind === "end")).toHaveLength(1);
  expect(visible.at(-1)).toMatchObject({ kind: "end", runId: "A", latest: true });
});
