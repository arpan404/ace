import { ThreadListEntry, type ThreadStatus } from "@ace/protocol";
import { describe, expect, it } from "vitest";
import { decodeKeys } from "../tui/keys.ts";
import { textWidth } from "../tui/layout.ts";
import { paint } from "../tui/paint.ts";
import type { Effect } from "./effects.ts";
import { homeKey } from "./home-model.ts";
import { homeStart, type HomeState } from "./home-state.ts";
import { homeRows, type HomeRow } from "./home-rows.ts";
import { homeView } from "./home-view.ts";

const now = 10_000_000;

function entry(id: string, status: ThreadStatus, extra: Record<string, unknown> = {}) {
  return ThreadListEntry.parse({
    workspaceId: "ace",
    title: `Thread ${id}`,
    provider: "claude",
    createdAt: 1,
    updatedAt: now - 60_000,
    hasSentMessage: true,
    ...extra,
    id,
    status,
  });
}

const rowsOf = (...entries: ThreadListEntry[]) =>
  homeRows({ entries, now, unconfirmed: false, projectName: (id) => id });

function press(rows: readonly HomeRow[], input: string, from: HomeState = homeStart) {
  let state = from;
  const effects: Effect[] = [];
  for (const key of decodeKeys(input)) {
    const next = homeKey(state, rows, key);
    state = next.state;
    effects.push(...next.effects);
  }
  return { state, effects };
}

describe("home rows", () => {
  it("never shows a thread as done while a subagent under its finished root still works", () => {
    const [row] = rowsOf(entry("t1", { state: "done" }, { live: { runningSubagentCount: 1 } }));
    expect(row?.state).toBe("working");
    expect(row?.glyph.startsWith("◌")).toBe(true);
    expect(row?.running).toBe(true);
  });

  it("puts threads that need the person first, then working ones, then the rest", () => {
    const rows = rowsOf(
      entry("rest", { state: "done" }, { updatedAt: now - 1000 }),
      entry("work", { state: "working", agents: 1 }),
      entry("asks", { state: "needs_you", interactions: 1 }),
    );
    expect(rows.map((row) => row.id)).toEqual(["asks", "work", "rest"]);
    expect(rows[0]?.glyph).toBe("◆");
  });

  it("claims no status while the list is an unconfirmed copy", () => {
    const [row] = homeRows({
      entries: [entry("t1", { state: "done" })],
      now,
      unconfirmed: true,
      projectName: (id) => id,
    });
    expect(row?.state).toBe("syncing");
    expect(row?.time).toBe("Syncing");
  });

  it("leaves snoozed and settled threads out of the list", () => {
    const rows = rowsOf(
      entry("live", { state: "done" }),
      entry("asleep", { state: "done" }, { snoozedUntil: now + 60_000 }),
    );
    expect(rows.map((row) => row.id)).toEqual(["live"]);
  });
});

describe("home keys", () => {
  const rows = rowsOf(entry("a", { state: "working", agents: 1 }), entry("b", { state: "done" }));

  it("moves with j and k and attaches to the selected row on Enter", () => {
    const { effects } = press(rows, "j\r");
    expect(effects).toEqual([{ kind: "attach", threadId: "b" }]);
    expect(press(rows, "jk\r").effects).toEqual([{ kind: "attach", threadId: "a" }]);
  });

  it("asks before stopping, and stops the whole tree on y", () => {
    const asked = press(rows, "x");
    expect(asked.effects).toEqual([]);
    expect(asked.state.confirmStop).toBe("a");
    const { effects } = press(rows, "y", asked.state);
    expect(effects).toEqual([
      expect.objectContaining({
        kind: "command",
        payload: { type: "thread.interrupt", threadId: "a", cascade: true },
      }),
    ]);
  });

  it("stops nothing when the person answers anything but yes", () => {
    const asked = press(rows, "x");
    expect(press(rows, "n", asked.state).effects).toEqual([]);
  });

  it("settles and snoozes the selected thread", () => {
    expect(press(rows, "je").effects).toEqual([
      expect.objectContaining({ payload: { type: "thread.settle", threadId: "b" } }),
    ]);
    expect(press(rows, "z").effects).toEqual([
      expect.objectContaining({
        payload: { type: "thread.snooze", threadId: "a", until: null, wake: "needs_you" },
      }),
    ]);
  });

  it("filters by typed words and attaches to what the filter keeps", () => {
    const { state, effects } = press(rows, "/Thread b\r\r");
    expect(state.filter).toEqual({ text: "Thread b", editing: false });
    expect(effects).toEqual([{ kind: "attach", threadId: "b" }]);
  });

  it("opens the agent tree under the row and folds it again", () => {
    const opened = press(rows, "\x1b[C");
    expect(opened.effects).toEqual([{ kind: "tree", threadId: "a" }]);
    expect(press(rows, "\x1b[D", opened.state).effects).toEqual([
      { kind: "tree", threadId: undefined },
    ]);
  });

  it("quits on q, and on Ctrl-C with the interrupted exit code", () => {
    expect(press(rows, "q").effects).toEqual([{ kind: "quit", farewell: "", code: 0 }]);
    expect(press(rows, "\x03").effects).toEqual([{ kind: "quit", farewell: "", code: 130 }]);
  });
});

describe("home view", () => {
  const rows = rowsOf(
    entry("a", { state: "needs_you", interactions: 1 }, { details: { branch: "ace/relay-sleep" } }),
    entry("b", { state: "done" }),
  );
  const view = { rows, loading: false, requests: 1, tree: undefined, connection: undefined };

  it("shows the rows with their meta and the keys line", () => {
    const lines = homeView(homeStart, view, 110, 20, paint(false));
    expect(lines[1]).toContain("◆");
    expect(lines[1]).toContain("ace/relay-sleep");
    expect(lines[1]).toContain("claude");
    expect(lines.at(-1)).toBe(
      "n new thread · r requests 1 · p projects · s Spade · m market · , settings · d doctor · ? help · q quit",
    );
    for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(110);
  });

  it("drops the meta columns below 60 columns", () => {
    const lines = homeView(homeStart, view, 50, 20, paint(false));
    expect(lines[1]).toContain("Thread a");
    expect(lines[1]).not.toContain("ace/relay-sleep");
    expect(lines[1]).not.toContain("claude");
    for (const line of lines) expect(textWidth(line)).toBeLessThanOrEqual(50);
    expect(lines.at(-1)?.endsWith("q quit")).toBe(true);
  });

  it("draws colour only when colour is on", () => {
    expect(homeView(homeStart, view, 100, 20, paint(false)).join("")).not.toContain("\x1b[");
    expect(homeView(homeStart, view, 100, 20, paint(true)).join("")).toContain("\x1b[33m");
  });

  it("draws the open row's agents under it, a working subagent as working", () => {
    const state = { ...homeStart, selected: "a", open: "a" };
    const tree = {
      lines: [
        { depth: 0, glyph: "✓", tone: "idle" as const, name: "claude", doing: "Done", time: "" },
        {
          depth: 1,
          glyph: "◌",
          tone: "working" as const,
          name: "reviewer",
          doing: "Reading the diff",
          time: "1m 2s",
        },
      ],
      more: 0,
    };
    const lines = homeView(state, { ...view, tree }, 100, 20, paint(false));
    expect(lines[2]).toContain("│ ✓ claude");
    expect(lines[3]).toContain("◌ reviewer");
    expect(lines[3]).toContain("1m 2s");
    expect(lines.at(-1)).toContain("↵ attach · ← fold");
  });
});
