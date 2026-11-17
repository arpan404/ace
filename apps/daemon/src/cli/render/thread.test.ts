import { describe, expect, test } from "vitest";
import { CliOpenRequest, CliTree, Interaction, Item } from "@ace/protocol";
import { outcomeLines, rootState, threadShowLines, treeLines } from "./thread.ts";
import { requestListLines, requestShowLines } from "./request.ts";
import { statusLines } from "./status.ts";

const at = 1_800_000_000_000;

function member(threadId: string, state: string, fields: Record<string, unknown> = {}) {
  return {
    threadId,
    status:
      state === "working"
        ? { state, agents: 1 }
        : state === "needs_you"
          ? { state, interactions: 1 }
          : { state },
    pending: false,
    queue: { revision: 1, paused: false, reason: null, resumeAt: null, uncertain: false },
    cancelled: false,
    title: `Agent ${threadId}`,
    ...fields,
  };
}

const tree = (members: unknown[]) => CliTree.parse(members);

describe("the agent tree", () => {
  test.each([
    {
      name: "a finished parent with a working child reads as waiting on it, never done",
      members: [
        member("t_parent", "done"),
        member("t_child1", "working", { parentId: "t_parent", pending: true }),
      ],
      root: "Waiting on 1 agent",
    },
    {
      name: "a finished parent with a child waiting on the person reads as needing you",
      members: [
        member("t_parent", "done"),
        member("t_child1", "needs_you", { parentId: "t_parent", pending: true }),
      ],
      root: "An agent under it needs you",
    },
    {
      name: "a finished parent whose children all settled reads as done",
      members: [member("t_parent", "done"), member("t_child1", "done", { parentId: "t_parent" })],
      root: "Done",
    },
    {
      name: "a working parent reads as working",
      members: [member("t_parent", "working")],
      root: "Working",
    },
  ])("$name", ({ members, root }) => {
    expect(rootState(tree(members))?.words).toBe(root);
    expect(treeLines(tree(members), false)[0]).toContain(root);
  });

  test("each agent sits under the one that delegated it", () => {
    const lines = treeLines(
      tree([
        member("t_parent", "working"),
        member("t_child1", "done", { parentId: "t_parent" }),
        member("t_grand1", "working", { parentId: "t_child1", pending: true }),
      ]),
      false,
    );
    expect(lines).toEqual([
      "◌ Agent t_parent  t_parent  Working",
      "  ◌1 Agent t_child1  t_child1  Waiting on 1 agent",
      "    ◌ Agent t_grand1  t_grand1  Working",
    ]);
  });

  test("colour appears only when asked for", () => {
    const members = [member("t_parent", "needs_you")];
    expect(treeLines(tree(members), false)[0]).not.toContain("\u001b[");
    expect(treeLines(tree(members), true)[0]).toContain("\u001b[33m");
  });
});

const question = Interaction.parse({
  id: "i_question",
  threadId: "t_parent",
  agentId: "root",
  blocking: true,
  state: "pending",
  createdAt: at - 120_000,
  request: {
    kind: "question",
    questions: [{ id: "db", text: "Which database?", options: [{ id: "pg", label: "Postgres" }] }],
  },
});

const open = CliOpenRequest.parse({
  threadId: "t_parent",
  threadTitle: "Fix the upload test",
  workspaceId: "w_ace",
  provider: "codex",
  interaction: question,
});

describe("a thread and its requests in words", () => {
  test("show prints the title, the state over the tree, the transcript and open requests", () => {
    const items = [
      { type: "message", role: "user", parts: [{ type: "text", text: "Fix the upload test" }] },
      {
        type: "tool_call",
        call: {
          id: "c1",
          agentId: "root",
          kind: "custom",
          title: "Ran bun test",
          status: "succeeded",
          detail: { kind: "custom" },
          startedAt: at,
          raw: [],
        },
      },
      { type: "message", role: "assistant", parts: [{ type: "text", text: "Fixed." }] },
    ].map((item, index) =>
      Item.parse({ id: `item${index}`, agentId: "root", createdAt: at, ...item }),
    );
    const lines = threadShowLines(
      {
        thread: {
          id: "t_parent",
          title: "Fix the upload test",
          provider: "codex",
          workspaceId: "w_ace",
          status: { state: "done" },
        },
        project: "ace",
        meaning: "Waiting on 1 agent",
        items,
        itemsBefore: 40,
        interactions: [question],
      },
      false,
    );
    expect(lines).toEqual([
      "Fix the upload test",
      "t_parent  ace  codex  Waiting on 1 agent",
      "Earlier: ace thread show t_parent --before 40",
      "",
      "› Fix the upload test",
      "  · Ran bun test",
      "  Fixed.",
      "",
      "? Which database?  ace request answer i_question",
    ]);
  });

  test("the request list names each request, where it waits and its age", () => {
    const lines = requestListLines(
      {
        requests: [open],
        truncated: false,
      },
      { now: at, colour: false, projectNames: new Map([["w_ace", "ace"]]) },
    );
    expect(lines).toEqual(["?  i_questi  Which database?   ace · Fix the upload test  2m"]);
    expect(
      requestListLines({ requests: [], truncated: false }, { now: at, colour: false }),
    ).toEqual(["Nothing needs you."]);
  });

  test("a question in full shows its choices and how to answer", () => {
    const lines = requestShowLines(open, false);
    expect(lines).toContain("Which database?  (db)");
    expect(lines).toContain("  pg  Postgres");
    expect(lines.at(-1)).toBe("ace request answer i_question");
  });

  test("a wait's outcome says done only for a finished tree", () => {
    const thread = { title: "Fix it" };
    expect(
      outcomeLines([
        { threadId: "t_a", status: "ok", thread, cancelled: [] },
        { threadId: "t_b", status: "needs-human", thread, cancelled: [] },
      ]),
    ).toEqual([
      "✓ Done  Fix it  t_a",
      "◆ Needs you  Fix it  t_b  See it with ace request list --thread t_b",
    ]);
  });
});

describe("ace status in words", () => {
  test.each([
    {
      view: { running: false },
      lines: ["ace isn't running. Start it with ace start, or open the app."],
    },
    {
      view: {
        running: true,
        version: "0.0.24",
        account: { signedIn: true, email: "person@example.com" },
        needsYou: 2,
        working: 1,
      },
      lines: [
        "ace is running (0.0.24).",
        "Signed in to ace as person@example.com.",
        "2 requests need you (ace request list), 1 thread working.",
      ],
    },
    {
      view: { running: true, account: { signedIn: false }, needsYou: 0, working: 0 },
      lines: [
        "ace is running.",
        "Not signed in to ace. Sign in with ace login.",
        "Nothing needs you, nothing working.",
      ],
    },
  ])("$view.running and its facts read in three lines", ({ view, lines }) => {
    expect(statusLines(view)).toEqual(lines);
  });
});
