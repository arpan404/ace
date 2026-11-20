import type { ThreadListEntry, ThreadStatus } from "@ace/protocol";
import { describe, expect, it } from "vitest";
import { trayHeadline, trayThreads } from "./tray-threads.ts";

const statuses = {
  needs_you: { state: "needs_you", interactions: 1 },
  working: { state: "working", agents: 1 },
  waiting: { state: "waiting", on: "background_task" },
  done: { state: "done" },
  failed: { state: "failed" },
} satisfies Record<string, ThreadStatus>;

function thread(
  id: string,
  state: keyof typeof statuses,
  updatedAt: number,
  archived = false,
): ThreadListEntry {
  const entry = {
    id,
    workspaceId: "w",
    title: id,
    provider: "claude",
    status: statuses[state],
    createdAt: 1,
    updatedAt,
    ...(archived ? { archivedAt: updatedAt } : {}),
  };
  return entry as ThreadListEntry;
}

function pick(...entries: ThreadListEntry[]) {
  const byId = new Map<string, ThreadListEntry>(entries.map((entry) => [entry.id, entry]));
  return trayThreads(
    entries.map((entry) => entry.id),
    (id) => byId.get(id),
  );
}

describe("the menu-bar popover's threads", () => {
  it("lists what needs the person apart from what works, latest change first", () => {
    const picked = pick(
      thread("old-work", "working", 10),
      thread("ask", "needs_you", 5),
      thread("new-work", "working", 30),
      thread("background", "waiting", 20),
    );
    expect(picked).toEqual({
      needsYou: ["ask"],
      working: ["new-work", "background", "old-work"],
    });
  });

  it("leaves out finished, failed and archived threads", () => {
    const picked = pick(
      thread("done", "done", 1),
      thread("failed", "failed", 2),
      thread("archived", "working", 3, true),
    );
    expect(picked).toEqual({ needsYou: [], working: [] });
  });
});

describe("the popover's headline", () => {
  it("counts what works and what needs the person", () => {
    expect(trayHeadline({ needsYou: ["a"], working: ["b", "c", "d"] })).toEqual({
      working: "3 working",
      needsYou: "1 needs you",
    });
    expect(trayHeadline({ needsYou: ["a", "b"], working: [] })).toEqual({
      working: "Nothing working",
      needsYou: "2 need you",
    });
  });
});
