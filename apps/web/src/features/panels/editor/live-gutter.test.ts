import { lineChanges } from "@ace/editor";
import { beforeAll, expect, test } from "vitest";
import { createBufferRegistry, type TextBuffer } from "@/features/editor-workbench/index.ts";
import {
  fakeDisk,
  inlineMerge,
  manualTime,
  memoryDrafts,
  ready,
  settle,
} from "@/features/editor-workbench/buffers/test-support.ts";
import type { AgentWho } from "./agent-lines.ts";
import { LiveGutter } from "./live-gutter.ts";

/*
 * An open file's change marks on a real buffer over a fake checkout: what the gutter marks
 * against the committed text as the person types, and which lines an agent wrote as its changes
 * land on disk (a reload) or through Merge.
 */

beforeAll(ready);

const file = { root: "m1/t1", path: "places.ts" };
const claude: AgentWho = { name: "Claude Code", provider: "claude", turn: 2 };
const committed = "one\ntwo\nthree\nfour\n";

/** Attribution kept across reloads, as the app keeps it on the device. */
function memory() {
  const saved = new Map<string, unknown>();
  return {
    read: (key: string) => saved.get(key) as never,
    write: (key: string, value: unknown) => {
      if (value === undefined) saved.delete(key);
      else saved.set(key, value);
    },
    saved,
  };
}

async function opened(disk = "one\ntwo\nthree\nfour\n", kept = memory()) {
  const checkout = fakeDisk({ "places.ts": disk });
  const time = manualTime();
  const registry = createBufferRegistry({
    files: checkout.port,
    drafts: memoryDrafts().store,
    merge: inlineMerge().port,
    now: time.now,
    schedule: time.schedule,
    ready,
    attribute: () => ({ kind: "agent", agent: "Claude Code", threadId: "t1", turn: 2 }),
  });
  const lease = registry.open(file);
  lease.setVisible(true);
  await settle();
  const buffer = lease.buffer;
  const gutter = new LiveGutter(buffer, {
    diff: { lineChanges: async (before, after) => lineChanges(before, after) },
    schedule: time.schedule,
    now: time.now,
    who: () => claude,
    delay: 150,
    memory: kept,
  });
  gutter.setHead(committed);
  const pause = async () => {
    await time.advance(200);
    await gutter.settled();
    await settle();
  };
  await pause();
  /** The app reloads: a fresh gutter on the same buffer, reading what the device kept. */
  const reopened = async (key?: string) => {
    gutter.dispose();
    const again = new LiveGutter(buffer, {
      ...(key === undefined ? {} : { key: () => key }),
      diff: { lineChanges: async (before, after) => lineChanges(before, after) },
      schedule: time.schedule,
      now: time.now,
      who: () => claude,
      delay: 150,
      memory: kept,
    });
    again.setHead(committed);
    await time.advance(200);
    await again.settled();
    await settle();
    return again;
  };
  return { checkout, registry, buffer, gutter, time, pause, reopened, kept };
}

function type(buffer: TextBuffer, line: number, text: string) {
  const doc = buffer.document();
  if (!doc) throw new Error("no document");
  doc.apply([
    { range: { start: { line, column: 0 }, end: { line, column: doc.line(line).length } }, text },
  ]);
  buffer.edited();
}

const marksOf = (gutter: LiveGutter) => [...(gutter.state().marks ?? [])];
const agentOf = (gutter: LiveGutter) =>
  gutter.state().agent.map((block) => [block.start, block.end, block.who.turn]);

test("a line typed over shows as modified against the committed text once typing pauses", async () => {
  const { buffer, gutter, pause } = await opened();
  expect(marksOf(gutter)).toEqual([]);

  type(buffer, 1, "TWO");
  gutter.edited();
  // Typing only schedules the work: the marks move once it pauses.
  expect(marksOf(gutter)).toEqual([]);
  await pause();

  expect(marksOf(gutter)).toEqual([[2, "modified"]]);
  expect(gutter.state().hunks[0]?.removed).toEqual(["two"]);
});

test("added lines, and lines removed, against the committed text", async () => {
  const { gutter } = await opened("one\nnew\ntwo\nfour\n");
  expect(marksOf(gutter)).toEqual([
    [2, "added"],
    [4, "removed"],
  ]);
});

test("an agent's change on disk marks the lines it wrote, with its turn", async () => {
  const { checkout, registry, gutter, pause } = await opened();

  checkout.write("places.ts", "one\nagent a\nagent b\nthree\nfour\n");
  registry.diskChanged(file);
  await settle();
  await pause();

  expect(agentOf(gutter)).toEqual([[1, 3, 2]]);
  // The same lines also carry their change against the last commit.
  expect(marksOf(gutter)).toEqual([
    [2, "modified"],
    [3, "added"],
  ]);
});

test("typing above an agent's lines moves them; typing in them makes them the person's", async () => {
  const { checkout, registry, buffer, gutter, pause } = await opened();
  checkout.write("places.ts", "one\ntwo\nagent\nfour\n");
  registry.diskChanged(file);
  await settle();
  await pause();
  expect(agentOf(gutter)).toEqual([[2, 3, 2]]);

  type(buffer, 0, "zero\none");
  gutter.edited();
  await pause();
  expect(agentOf(gutter)).toEqual([[3, 4, 2]]);

  type(buffer, 3, "agent, edited");
  gutter.edited();
  await pause();
  expect(agentOf(gutter)).toEqual([]);
  // The edited line still shows its change against the last commit.
  expect(marksOf(gutter)).toContainEqual([4, "modified"]);
});

test("Merge lands the agent's lines beside the person's unsaved ones, and marks only the agent's", async () => {
  const { checkout, registry, buffer, gutter, pause } = await opened();
  type(buffer, 3, "four, mine");
  gutter.edited();
  checkout.write("places.ts", "one, agent\ntwo\nthree\nfour\n");
  registry.diskChanged(file);
  await settle();
  expect(buffer.snapshot().clash?.kind).toBe("changed");

  await buffer.merge();
  await settle();
  await pause();

  expect(buffer.document()?.text()).toBe("one, agent\ntwo\nthree\nfour, mine\n");
  expect(agentOf(gutter)).toEqual([[0, 1, 2]]);
  expect(marksOf(gutter)).toEqual([
    [1, "modified"],
    [4, "modified"],
  ]);
});

test("keeping an agent's lines drops their mark", async () => {
  const { checkout, registry, gutter, pause } = await opened();
  checkout.write("places.ts", "one\nagent\nthree\nfour\n");
  registry.diskChanged(file);
  await settle();
  await pause();

  gutter.keep(1, 2);
  expect(agentOf(gutter)).toEqual([]);
});

test("Revert puts the committed lines back and leaves them unsaved", async () => {
  const { buffer, gutter, checkout, pause } = await opened("one\nTWO\nthree\nfour\n");
  const [hunk] = gutter.state().hunks;
  if (!hunk) throw new Error("no hunk");

  expect(gutter.revert(hunk)).toBe(true);

  expect(buffer.document()?.text()).toBe(committed);
  expect(buffer.snapshot().dirty).toBe(true);
  // Nothing written: the person saves when they choose to.
  expect(checkout.text("places.ts")).toBe("one\nTWO\nthree\nfour\n");
  await pause();
  expect(marksOf(gutter)).toEqual([]);
});

test("a hunk worked out before the text moved reverts nothing, even a removal with no lines to check", async () => {
  // "three" was removed since the commit: the hunk is a gap above "four", with no lines of its own.
  const { checkout, registry, buffer, gutter } = await opened("one\ntwo\nfour\n");
  const [gap] = gutter.state().hunks;
  expect(gap).toMatchObject({ start: 3, added: [], removed: ["three"] });
  if (!gap) throw new Error("no hunk");

  // An agent adds lines above it; the gutter hasn't looked again yet.
  checkout.write("places.ts", "zero\nzero b\none\ntwo\nfour\n");
  registry.diskChanged(file);
  await settle();

  expect(gutter.revert(gap)).toBe(false);
  expect(buffer.document()?.text()).toBe("zero\nzero b\none\ntwo\nfour\n");
});

test("a hunk worked out against an older commit reverts nothing", async () => {
  const { buffer, gutter } = await opened("one\nTWO\nthree\nfour\n");
  const [hunk] = gutter.state().hunks;
  if (!hunk) throw new Error("no hunk");

  gutter.setHead("one\ntwo, newer commit\nthree\nfour\n");

  expect(gutter.revert(hunk)).toBe(false);
  expect(buffer.document()?.text()).toBe("one\nTWO\nthree\nfour\n");
});

test.each([
  { name: "a CRLF file", disk: "one\r\nTWO\r\nthree\r\n", head: "one\r\ntwo\r\nthree\r\n" },
  { name: "a last line with no newline", disk: "one\nTWO", head: "one\ntwo" },
  { name: "a removed last line with no newline", disk: "one\n", head: "one\ntwo" },
])("Revert puts back exactly the committed text in $name", async ({ disk, head }) => {
  const { buffer, gutter, pause } = await opened(disk);
  gutter.setHead(head);
  await pause();
  const [hunk] = gutter.state().hunks;
  if (!hunk) throw new Error("no hunk");

  expect(gutter.revert(hunk)).toBe(true);

  expect(buffer.document()?.text()).toBe(head);
});

test("editing one of an agent's lines clears only that line, and undo brings it back however late", async () => {
  const { checkout, registry, buffer, gutter, pause } = await opened();
  checkout.write("places.ts", "one\nagent a\nagent b\nagent c\nfour\n");
  registry.diskChanged(file);
  await settle();
  await pause();
  expect(agentOf(gutter)).toEqual([[1, 4, 2]]);

  type(buffer, 2, "agent b, edited");
  gutter.edited();
  await pause();
  expect(agentOf(gutter)).toEqual([
    [1, 2, 2],
    [3, 4, 2],
  ]);

  // Well after the pause, undo puts the agent's line back: it is the agent's again.
  buffer.document()?.undo();
  buffer.edited();
  gutter.edited();
  await pause();
  expect(agentOf(gutter)).toEqual([[1, 4, 2]]);
});

test("the agent's lines come back after a reload while the text is the same, and not otherwise", async () => {
  const { checkout, registry, buffer, gutter, pause, reopened } = await opened();
  checkout.write("places.ts", "one\nagent a\nthree\nfour\n");
  registry.diskChanged(file);
  await settle();
  await pause();
  expect(agentOf(gutter)).toEqual([[1, 2, 2]]);

  const again = await reopened();
  expect(agentOf(again)).toEqual([[1, 2, 2]]);
  expect(again.state().agent[0]?.who).toEqual(claude);

  // Another line changing while nobody watched doesn't matter: the agent's line is as it was.
  type(buffer, 3, "four, edited elsewhere");
  expect(agentOf(await reopened())).toEqual([[1, 2, 2]]);
  // The agent's own line rewritten while nobody watched: no stale mark.
  type(buffer, 1, "rewritten elsewhere");
  expect(agentOf(await reopened())).toEqual([]);
});

test("the same file on another machine or in another checkout gets none of the kept lines", async () => {
  const { checkout, registry, gutter, pause, reopened } = await opened();
  checkout.write("places.ts", "one\nagent a\nthree\nfour\n");
  registry.diskChanged(file);
  await settle();
  await pause();
  expect(agentOf(gutter)).toEqual([[1, 2, 2]]);

  expect(agentOf(await reopened("other-machine\u0000/repo\u0000places.ts"))).toEqual([]);
});

test("while git's diff of this version is still being read, Revert does nothing", async () => {
  const { buffer, gutter, pause } = await opened("one\nTWO\nthree\nfour\n");
  const [hunk] = gutter.state().hunks;
  if (!hunk) throw new Error("no hunk");
  // A commit moved HEAD; the diff for it is not in yet (the shown hunks are the old read's).
  gutter.unsettle();
  expect(gutter.revert(hunk)).toBe(false);
  expect(buffer.document()?.text()).toBe("one\nTWO\nthree\nfour\n");

  // The read settles for the new commit: the new hunks act, the old one doesn't.
  gutter.setHead("one\nTWO\nthree\nfour, committed\n", "commit-2");
  expect(gutter.revert(hunk)).toBe(false);
  await pause();
  const [now] = gutter.state().hunks;
  expect(now?.removed).toEqual(["four, committed"]);
  if (now) expect(gutter.revert(now)).toBe(true);
});

/** The 0-based lines shown as an agent's, each once. */
const agentLines = (gutter: LiveGutter) =>
  gutter
    .state()
    .agent.flatMap((block) =>
      Array.from({ length: block.end - block.start }, (_, index) => block.start + index),
    )
    .toSorted((a, b) => a - b);

test("a later agent change to one line of an earlier block leaves the rest of it the agent's", async () => {
  const { checkout, registry, gutter, pause } = await opened();
  checkout.write("places.ts", "one\nagent a\nagent b\nagent c\nfour\n");
  registry.diskChanged(file);
  await settle();
  await pause();
  expect(agentLines(gutter)).toEqual([1, 2, 3]);

  checkout.write("places.ts", "one\nagent a\nagent B, again\nagent c\nfour\n");
  registry.diskChanged(file);
  await settle();
  await pause();
  expect(agentLines(gutter)).toEqual([1, 2, 3]);
});

test("a line the person edited stays theirs to undo back across an unrelated agent change", async () => {
  const { checkout, registry, buffer, gutter, pause } = await opened();
  checkout.write("places.ts", "one\nagent a\nagent b\nfour\n");
  registry.diskChanged(file);
  await settle();
  await pause();

  type(buffer, 1, "mine");
  gutter.edited();
  await pause();
  expect(agentLines(gutter)).toEqual([2]);

  // The agent changes an unrelated line; Merge lands it beside the person's edit.
  checkout.write("places.ts", "one\nagent a\nagent b\nfour, agent\n");
  registry.diskChanged(file);
  await settle();
  await buffer.merge();
  await settle();
  await pause();
  expect(agentLines(gutter)).toEqual([2, 3]);

  // Undo the merge, then the person's edit: the agent's first line is back, and the agent's again.
  buffer.document()?.undo();
  buffer.document()?.undo();
  buffer.edited();
  gutter.edited();
  await pause();
  expect(buffer.document()?.text()).toBe("one\nagent a\nagent b\nfour\n");
  expect(agentLines(gutter)).toEqual([1, 2]);
});

test("Keep retires only the kept lines: an edited agent line elsewhere still comes back on undo", async () => {
  const { checkout, registry, buffer, gutter, pause } = await opened();
  checkout.write("places.ts", "one\nagent a\nagent b\nagent c\nfour\n");
  registry.diskChanged(file);
  await settle();
  await pause();

  type(buffer, 1, "mine");
  gutter.edited();
  await pause();
  expect(agentLines(gutter)).toEqual([2, 3]);

  // The person keeps the agent's last line.
  expect(await gutter.keep(3, 4)).toBe(true);
  expect(agentLines(gutter)).toEqual([2]);

  // Undoing their edit still brings the agent's first line back; the kept one stays kept.
  buffer.document()?.undo();
  buffer.edited();
  gutter.edited();
  await pause();
  expect(agentLines(gutter)).toEqual([1, 2]);
});

test("a Keep the text moved under before it ran retires nothing, never the wrong lines", async () => {
  const { checkout, registry, buffer, gutter, pause } = await opened();
  checkout.write("places.ts", "one\nagent a\nagent b\nagent c\nfour\n");
  registry.diskChanged(file);
  await settle();
  await pause();
  expect(agentLines(gutter)).toEqual([1, 2, 3]);

  // Keep line 3 ("agent c"), and a line is typed at the top before the Keep's work runs.
  const kept = gutter.keep(3, 4);
  type(buffer, 0, "zero\none");
  // The gutter says it didn't: the review neither records the Keep nor moves on.
  expect(await kept).toBe(false);
  gutter.edited();
  await pause();

  // Line 3 now is "agent b": it is not retired; nothing is, and every agent line moved down one.
  expect(agentLines(gutter)).toEqual([2, 3, 4]);
});

test("hunks worked out against the old commit are never published as the new commit's", async () => {
  const { buffer, time } = await opened("one\nTWO\nthree\nfour\n");
  const held: (() => void)[] = [];
  const gutter = new LiveGutter(buffer, {
    diff: {
      lineChanges: (before, after) =>
        new Promise((resolve) => held.push(() => resolve(lineChanges(before, after)))),
    },
    schedule: time.schedule,
    now: time.now,
    who: () => claude,
    delay: 150,
  });
  const oldCommit = "a".repeat(40);
  const newCommit = "b".repeat(40);
  gutter.setHead(committed, "c1", oldCommit);
  await time.advance(200);
  // HEAD moves while the diff against the old commit is still out.
  gutter.setHead("one\nTWO\nthree\nfour\n", "c2", newCommit);
  for (const release of held.splice(0)) release();
  await settle();
  const late = gutter.state();
  expect(late.basis?.commit === newCommit && late.hunks.length > 0).toBe(false);

  // The new commit's own diff lands: its hunks say so (the text is as committed now).
  await time.advance(200);
  for (let round = 0; round < 3; round++) {
    for (const release of held.splice(0)) release();
    await settle();
  }
  expect(gutter.state().basis?.commit).toBe(newCommit);
  expect(gutter.state().hunks).toEqual([]);
  gutter.dispose();
});

test("the hunks are current only for the text as it is and the read of git's diff that is in", async () => {
  const { buffer, gutter, pause } = await opened("one\nTWO\nthree\nfour\n");
  gutter.setHead(committed, "c1", "a".repeat(40));
  await pause();
  expect(gutter.current()).toBe(true);

  // A save sends a new read out: listeners hear it, and the hunks stop holding.
  let told = 0;
  const off = gutter.subscribe(() => told++);
  gutter.unsettle();
  expect(told).toBe(1);
  expect(gutter.current()).toBe(false);

  // The read lands with the committed text for the new disk version: current once worked out.
  gutter.setHead(committed, "c1-v2", "a".repeat(40));
  expect(gutter.current()).toBe(false);
  await pause();
  expect(gutter.current()).toBe(true);

  // Typing moves the text past the hunks until the pause.
  type(buffer, 0, "ONE");
  gutter.edited();
  expect(gutter.current()).toBe(false);
  await pause();
  expect(gutter.current()).toBe(true);
  off();
});
