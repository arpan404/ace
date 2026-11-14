import { ThreadListEntry, type ThreadPlace } from "@ace/protocol";
import { expect, test } from "vitest";
import { tabsKeeper } from "./use-home-threads.ts";

const entry = (id: string, title = `Thread ${id}`) =>
  ThreadListEntry.parse({
    id,
    workspaceId: "ace",
    title,
    provider: "codex",
    createdAt: 0,
    updatedAt: 0,
    status: { state: "done" },
  });
const inbox = (rank: number): ThreadPlace => ({ tab: "inbox", band: "running", rank: [rank] });

test("a change that moves no thread keeps the sorted panel, and one that moves a thread sorts again", () => {
  const keep = tabsKeeper();
  const ranks = new Map([
    ["a", 2],
    ["b", 1],
  ]);
  const place = (item: ThreadListEntry) => inbox(ranks.get(item.id) ?? 0);
  const first = keep([entry("a"), entry("b")], place);
  expect(first.inbox).toEqual(["a", "b"]);

  // A new title (a step, a status word) on the same place: the same panel, unsorted again.
  expect(keep([entry("a", "Renamed"), entry("b")], place)).toBe(first);

  ranks.set("b", 3);
  const moved = keep([entry("a"), entry("b")], place);
  expect(moved.inbox).toEqual(["b", "a"]);
  // A thread joining the list counts as a change too.
  expect(keep([entry("a"), entry("b"), entry("c")], place).inbox).toEqual(["b", "a", "c"]);
});
