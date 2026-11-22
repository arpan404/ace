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

async function opened(disk = "one\ntwo\nthree\nfour\n") {
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
  });
  gutter.setHead(committed);
  const pause = async () => {
    await time.advance(200);
    await gutter.settled();
    await settle();
  };
  await pause();
  return { checkout, registry, buffer, gutter, time, pause };
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
