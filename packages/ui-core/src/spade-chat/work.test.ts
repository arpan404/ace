import { describe, expect, test } from "vitest";
import {
  emptySpadeConversation,
  foldSpade,
  parseSpadeGoalProgress,
  parseSpadeLiveFrame,
  parseSpadeTask,
  parseSpadeTree,
  spadeBotWorkers,
  spadeCriteriaMarks,
  spadeDecisionsShown,
  spadeGoalHeading,
  spadeGoalLine,
  spadeGoalMissing,
  spadeGoalShown,
  spadePlanRows,
  spadeQuoted,
  spadeView,
  spadeWorkerRows,
  spadeWorkersSpend,
} from "./index.ts";

const progress = (state: string, verified = 4, total = 6) => ({
  state,
  items_total: total,
  items_closed: verified,
  items_verified: verified,
});

const taskBody = (fields: Record<string, unknown> = {}) =>
  JSON.stringify({
    task: {
      goal: {
        id: "g1",
        title: "Get #2081 merged",
        text: "get the relay PR green on linux and merged this week",
        criteria: [
          { id: "1", text: "CI passes on Linux and macOS" },
          { id: "2", text: "The handshake test uses the fake clock" },
          { id: "3", text: "#2081 has an approving review" },
        ],
        by: "bot",
      },
      items: [
        {
          id: "1",
          text: "Reproduce",
          status: "done",
          verified: true,
          split: false,
          evidence: [{ kind: "output", call: "c1" }],
        },
        {
          id: "2",
          text: "Fake clock",
          status: "done",
          verified: false,
          split: true,
          evidence: [{ kind: "file", path: "noise.test.ts" }],
        },
        {
          id: "2.1",
          text: "Swap the sleep",
          parent: "2",
          status: "done",
          verified: true,
          split: false,
        },
        {
          id: "3",
          text: "CI green",
          status: "working",
          reason: "run 18240117 still fails",
          verified: false,
          split: false,
        },
        {
          id: "4",
          text: "Ask for a review",
          status: "blocked",
          reason: "Waits on your review",
          verified: false,
          split: false,
        },
        { id: "5", text: "Merge", status: "open", verified: false, split: false },
      ],
      verdict: {
        claim: "k1",
        finding: "not_yet",
        criteria: [
          { id: "1", met: false, why: "Linux run 18240117 failed." },
          { id: "2", met: true, why: "" },
          { id: "3", met: false, why: "No review yet." },
        ],
        rejected: [],
        missing: ["Linux CI still fails"],
      },
      checkpoint: null,
      progress: progress("not_yet", 3, 6),
      ...fields,
    },
  });

const line = (state: string, missing?: string) =>
  spadeGoalLine(parseSpadeGoalProgress({ task_progress: progress(state) }), missing);

describe("goal progress words", () => {
  test("the row says only what the check derived, never the bot's own done", () => {
    expect(line("working")).toBe("4 of 6 verified");
    expect(line("checking")).toBe("Checking");
    expect(line("not_yet", "Linux CI still fails")).toBe("Not yet: Linux CI still fails");
    expect(line("not_yet")).toBe("Not yet");
    expect(line("unchecked")).toBe("Says done, not checked");
    expect(line("done")).toBe("Done · 4 of 6 verified");
    expect(line("none")).toBeUndefined();
  });

  test("a bot whose task_state says done but whose check didn't pass reads as not done", () => {
    const record = { task_state: { status: "done" }, task_progress: progress("unchecked") };
    expect(spadeGoalLine(parseSpadeGoalProgress(record))).toBe("Says done, not checked");
  });

  test("a Spade before goals has no progress, and no line", () => {
    expect(spadeGoalLine(parseSpadeGoalProgress({}))).toBeUndefined();
  });

  test("the heading names the state once", () => {
    const task = parseSpadeTask(taskBody());
    if (!task) throw new Error("unread");
    expect(spadeGoalHeading(task.progress)).toBe("Not yet");
    expect(spadeGoalMissing(task)).toBe("Linux CI still fails");
  });
});

describe("the task", () => {
  test("a bot that never had a goal answers null, and shows no goal", () => {
    expect(parseSpadeTask(JSON.stringify({ task: null }))).toBeNull();
    expect(spadeGoalShown(null)).toBe(false);
    expect(parseSpadeTask("nonsense")).toBeUndefined();
  });

  test("a goal the person ended is gone; a done one stays", () => {
    const ended = parseSpadeTask(
      taskBody({ goal: { id: "g", title: "T", criteria: [], closed: "cleared" } }),
    );
    expect(spadeGoalShown(ended)).toBe(false);
    const done = parseSpadeTask(
      taskBody({ goal: { id: "g", title: "T", criteria: [], closed: "done" } }),
    );
    expect(spadeGoalShown(done)).toBe(true);
  });

  test("not yet: each unmet criterion carries the check's reason, the met one its mark", () => {
    const task = parseSpadeTask(taskBody());
    if (!task) throw new Error("unread");
    const { criteria, note } = spadeCriteriaMarks(task);
    expect(criteria.map((c) => [c.met, c.why])).toEqual([
      [false, "Linux run 18240117 failed."],
      [true, undefined],
      [false, "No review yet."],
    ]);
    expect(note).toBeUndefined();
  });

  test("checking: earlier marks stay and no reasons show on what's open", () => {
    const task = parseSpadeTask(taskBody({ progress: progress("checking") }));
    if (!task) throw new Error("unread");
    expect(spadeCriteriaMarks(task).criteria.map((c) => [c.met, c.why])).toEqual([
      [false, undefined],
      [true, undefined],
      [false, undefined],
    ]);
  });

  test("a check that couldn't run says why once, and that it runs on the next claim", () => {
    const task = parseSpadeTask(
      taskBody({
        progress: progress("unchecked"),
        verdict: {
          claim: "k2",
          finding: "unchecked",
          criteria: [],
          rejected: [],
          missing: ["The model didn't answer."],
        },
      }),
    );
    if (!task) throw new Error("unread");
    expect(spadeCriteriaMarks(task).note).toBe(
      "The check couldn't run: the model didn't answer. It runs again on the next claim.",
    );
  });

  test("done: every criterion is met", () => {
    const task = parseSpadeTask(taskBody({ progress: progress("done", 6, 6) }));
    if (!task) throw new Error("unread");
    expect(spadeCriteriaMarks(task).criteria.every((c) => c.met)).toBe(true);
  });

  test("the plan reads in order, children under their parent, each with its mark and note", () => {
    const task = parseSpadeTask(taskBody());
    if (!task) throw new Error("unread");
    expect(
      spadePlanRows(task.items).map((row) => [row.item.id, row.depth, row.mark, row.note?.text]),
    ).toEqual([
      ["1", 0, "verified", undefined],
      ["2", 0, "claimed", undefined],
      ["2.1", 1, "verified", undefined],
      ["3", 0, "working", "run 18240117 still fails"],
      ["4", 0, "waiting", "Waits on your review"],
      ["5", 0, "open", undefined],
    ]);
    expect(task.items[0]?.evidence).toEqual([{ kind: "output", call: "c1" }]);
  });

  test("an item whose parent is missing stays listed at the top", () => {
    const rows = spadePlanRows([
      {
        id: "9.1",
        text: "Orphan",
        parent: "9",
        status: "open",
        evidence: [],
        reason: undefined,
        verified: false,
      },
    ]);
    expect(rows.map((row) => [row.item.id, row.depth])).toEqual([["9.1", 0]]);
  });
});

const tree = {
  tree: {
    kind: "bot",
    id: "lead",
    name: "Github watcher",
    conversation: "c-lead",
    state: "waiting",
    needs_you: true,
    cost_micros: 2_000_000,
    subtree_cost_micros: 3_960_000,
    queued: false,
    children: [
      {
        kind: "bot",
        id: "w1",
        name: "Linux repro",
        conversation: "c-w1",
        state: "working",
        status: "Running the relay tests on Ubuntu",
        needs_you: false,
        cost_micros: 840_000,
        subtree_cost_micros: 840_000,
        queued: false,
        children: [
          {
            kind: "ace",
            id: "t1",
            name: "Fix the handshake timer",
            state: "working",
            needs_you: false,
            cost_micros: null,
            children: [],
          },
        ],
      },
      { kind: "helper", id: "job1", name: "researcher", state: "working", children: [] },
      {
        kind: "bot",
        id: "w2",
        name: "Changelog",
        state: "idle",
        needs_you: false,
        progress: progress("done", 3, 3),
        cost_micros: 610_000,
        children: [],
      },
      {
        kind: "bot",
        id: "w3",
        name: "Notes",
        state: "idle",
        needs_you: false,
        progress: progress("none", 0, 0),
        cost_micros: 0,
        children: [],
      },
      {
        kind: "ace",
        id: "t2",
        name: "Rebase #2081 on main",
        state: "needs_you",
        needs_you: true,
        cost_micros: null,
        children: [],
      },
      { kind: "mystery", id: "x" },
    ],
  },
};

describe("workers", () => {
  test("bots and ace agents list under their maker with their words; helpers stay in chat", () => {
    const rows = spadeWorkerRows(parseSpadeTree(JSON.stringify(tree)));
    expect(rows.map((row) => [row.node.name, row.depth, row.line, row.tone, row.running])).toEqual([
      ["Linux repro", 0, "Running the relay tests on Ubuntu", "working", true],
      ["Fix the handshake timer", 1, "Working", "working", true],
      ["Changelog", 0, "Done · 3 of 3 verified", "rest", false],
      ["Notes", 0, "Finished, not verified", "rest", false],
      ["Rebase #2081 on main", 0, "Needs you in Threads", "needs-you", true],
    ]);
  });

  test("spend is plain: each bot's own, nothing for ace agents, the workers' sum in all", () => {
    const parsed = parseSpadeTree(JSON.stringify(tree));
    expect(spadeWorkerRows(parsed).map((row) => row.spendMicros)).toEqual([
      840_000,
      undefined,
      610_000,
      undefined,
      undefined,
    ]);
    expect(spadeWorkersSpend(parsed)).toBe(1_960_000);
  });

  test("a delete asks about the bots it made, not its ace agents or helpers", () => {
    expect(spadeBotWorkers(parseSpadeTree(JSON.stringify(tree))).map((n) => n.name)).toEqual([
      "Linux repro",
      "Changelog",
      "Notes",
    ]);
  });

  test("a worker made past the setting waits to start, and can be stopped", () => {
    const queued = {
      tree: {
        ...tree.tree,
        children: [
          { kind: "bot", id: "q", name: "Later", state: "idle", queued: true, children: [] },
        ],
      },
    };
    const [row] = spadeWorkerRows(parseSpadeTree(JSON.stringify(queued)));
    expect([row?.line, row?.running]).toEqual(["Waiting to start", true]);
  });
});

describe("decisions", () => {
  test("the chat fold keeps each decision the bot made, and the view lists them", () => {
    const state = emptySpadeConversation();
    const store = (seq: number, event: Record<string, unknown>) => {
      const input = parseSpadeLiveFrame("stored", JSON.stringify({ seq, at: seq * 1000, event }));
      if (input) foldSpade(state, input);
    };
    store(1, {
      type: "decision_made",
      decision: "d1",
      call_id: "c1",
      choice: "Rebased on main",
      reason: "No merge commits.",
      options: ["Merge main in"],
    });
    store(2, { type: "something_new", words: "kept as unknown" });
    store(3, {
      type: "decision_made",
      decision: "d2",
      call_id: "c2",
      choice: "Left macOS alone",
      reason: "Only Linux is slow.",
      item: "3",
    });
    const shown = spadeDecisionsShown(spadeView(state).decisions);
    expect(shown.map((d) => [d.id, d.choice, d.reason, d.item, d.at])).toEqual([
      ["d2", "Left macOS alone", "Only Linux is slow.", "3", 3000],
      ["d1", "Rebased on main", "No merge commits.", undefined, 1000],
    ]);
    expect(state.unknown).toBe(1);
  });

  test("Change quotes the decision before the person's words", () => {
    expect(spadeQuoted("Rebased #2081 on main", "merge main in instead")).toBe(
      "> Rebased #2081 on main\n\nmerge main in instead",
    );
  });
});
