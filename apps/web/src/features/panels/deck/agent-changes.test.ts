import { Item } from "@ace/protocol";
import type { Turn } from "@ace/ui-core";
import { describe, expect, it } from "vitest";
import {
  changeNotice,
  editCallsOf,
  keepOpen,
  nextChange,
  noChanges,
  recordChange,
  seeChanges,
  treeMarks,
} from "./agent-changes.ts";

const claude = { kind: "agent", agent: "Claude Code", threadId: "t1" } as const;
const other = { kind: "thread", threadId: "t2", title: "Fix relay loop", agent: "Codex" } as const;

describe("agents' changes to open files", () => {
  it("names who changed how many open files, until the person looks at them", () => {
    let changes = recordChange(noChanges, "src/a.ts", claude);
    changes = recordChange(changes, "src/b.ts", claude);
    expect(changeNotice(changes)).toBe("Claude Code changed 2 open files");
    changes = seeChanges(changes, ["src/a.ts"]);
    expect(changeNotice(changes)).toBe("Claude Code changed 1 open file");
    changes = seeChanges(changes, ["src/b.ts"]);
    expect(changeNotice(changes)).toBeUndefined();
  });

  it("names another thread by its title, and several changers together", () => {
    let changes = recordChange(noChanges, "a.ts", claude);
    changes = recordChange(changes, "b.ts", other);
    expect(changeNotice(changes)).toBe("Claude Code and Fix relay loop changed 2 open files");
  });

  it("leaves no mark for a change nobody can be named for", () => {
    expect(recordChange(noChanges, "a.ts", { kind: "unknown" })).toBe(noChanges);
  });

  it("drops a closed file's mark with its tab", () => {
    const changes = recordChange(recordChange(noChanges, "a.ts", claude), "b.ts", claude);
    expect([...keepOpen(changes, ["b.ts"]).keys()]).toEqual(["b.ts"]);
  });

  it("steps Next change through unseen files in open order, wrapping, and back with ⇧", () => {
    const open = ["a.ts", "b.ts", "c.ts", "d.ts"];
    const changes = recordChange(recordChange(noChanges, "d.ts", claude), "b.ts", claude);
    expect(nextChange(changes, open, "a.ts")).toBe("b.ts");
    expect(nextChange(changes, open, "b.ts")).toBe("d.ts");
    expect(nextChange(changes, open, "d.ts")).toBe("b.ts");
    expect(nextChange(changes, open, "c.ts", -1)).toBe("b.ts");
    expect(nextChange(noChanges, open, "a.ts")).toBeUndefined();
  });
});

function editTurn(id: string, createdAt: number, paths: string[], movePath?: string): Turn {
  const item = Item.parse({
    type: "tool_call",
    id,
    agentId: "a1",
    createdAt,
    call: {
      id,
      agentId: "a1",
      kind: "file.edit",
      title: "Edit",
      status: "succeeded",
      detail: {
        kind: "file.edit",
        changes: paths.map((path) => ({ kind: "update", path, ...(movePath ? { movePath } : {}) })),
      },
      startedAt: createdAt,
      raw: [],
    },
  });
  if (item.type !== "tool_call") throw new Error("not a tool call");
  return { id: `turn-${id}`, number: 1, edits: [item] };
}

describe("the edit calls attribution reads", () => {
  const thread = { threadId: "t1", threadTitle: "Deck", agent: "Claude Code" };

  it("dates each call at the earlier of when it was made and when this client saw it", () => {
    const turns = [editTurn("i1", 5_000, ["src/a.ts"]), editTurn("i2", 90_000, ["src/b.ts"])];
    // i1 came with the history load (seen late); i2 arrived live, before the daemon's clock said.
    const seen = new Map([
      ["i1", 80_000],
      ["i2", 85_000],
    ]);
    const calls = editCallsOf(turns, thread, (id) => seen.get(id) ?? 0);
    expect(calls.map((call) => [call.path, call.at])).toEqual([
      ["src/a.ts", 5_000],
      ["src/b.ts", 85_000],
    ]);
    expect(calls[0]).toMatchObject({ threadId: "t1", threadTitle: "Deck", agent: "Claude Code" });
  });

  it("counts a move for both its old and new path", () => {
    const calls = editCallsOf([editTurn("i1", 1, ["old.ts"], "new.ts")], thread, () => 1);
    expect(calls.map((call) => call.path)).toEqual(["old.ts", "new.ts"]);
  });
});

describe("explorer rows' marks", () => {
  const call = (path: string, at: number) => ({
    threadId: "t1",
    threadTitle: "",
    agent: "Claude Code",
    path,
    at,
  });
  const minute = 60_000;
  const base = {
    checkout: "/repo",
    threadId: "t1",
    open: noChanges,
    openPaths: [] as string[],
    looked: new Map<string, number>(),
    now: 100 * minute,
  };

  it("marks a file this thread's agent edited recently, with its newest edit", () => {
    const marks = treeMarks({
      ...base,
      calls: [call("src/a.ts", 90 * minute), call("/repo/src/a.ts", 96 * minute)],
    });
    expect(marks.get("src/a.ts")).toEqual({ author: claude, at: 96 * minute });
  });

  it("leaves no mark for an edit past the window or before the person last looked", () => {
    const marks = treeMarks({
      ...base,
      calls: [call("old.ts", 60 * minute), call("seen.ts", 95 * minute)],
      looked: new Map([["seen.ts", 97 * minute]]),
    });
    expect(marks.size).toBe(0);
  });

  it("follows the tab for an open file: marked only while its tab is", () => {
    const calls = [call("open.ts", 99 * minute), call("marked.ts", 99 * minute)];
    const open = recordChange(noChanges, "marked.ts", other);
    const marks = treeMarks({ ...base, calls, open, openPaths: ["open.ts", "marked.ts"] });
    expect(marks.has("open.ts")).toBe(false);
    // The tab names who it names (here another thread), and so does the row.
    expect(marks.get("marked.ts")?.author).toEqual(other);
  });

  it("ignores edits outside this checkout", () => {
    const marks = treeMarks({ ...base, calls: [call("/elsewhere/src/a.ts", 99 * minute)] });
    expect(marks.size).toBe(0);
  });
});
