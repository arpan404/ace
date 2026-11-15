import { Item, type ToolDetail } from "@ace/protocol";
import { expect, it } from "vitest";
import {
  backgroundFact,
  groupSteps,
  groupSummary,
  retriedStepIds,
  stepFact,
  type StepFact,
} from "./index.ts";

let created = 0;
function call(
  id: string,
  detail: ToolDetail,
  options: { status?: "succeeded" | "failed" | "running" | undefined; agent?: string } = {},
) {
  return Item.parse({
    id,
    agentId: options.agent ?? "root",
    type: "tool_call",
    createdAt: ++created,
    complete: options.status !== "running",
    call: {
      id,
      agentId: options.agent ?? "root",
      kind: detail.kind,
      title: id,
      status: options.status ?? "succeeded",
      startedAt: created,
      detail,
      raw: [],
    },
  });
}
const read = (id: string, path = `${id}.ts`) => call(id, { kind: "file.read", path });
const search = (id: string) => call(id, { kind: "search", query: id });
const shell = (id: string, command: string, status?: "succeeded" | "failed" | "running") =>
  call(id, { kind: "shell", command }, { status });
const editDetail = (path: string): ToolDetail => ({
  kind: "file.edit",
  changes: [{ path, kind: "update", diff: "@@ -1 +1 @@\n-a\n+b" }],
});
const edit = (id: string, path: string) => call(id, editDetail(path));
const ask = (id: string) => call(id, { kind: "ask_user" });
const spawn = (id: string) => call(id, { kind: "agent.spawn", description: id });
const tell = (id: string) => call(id, { kind: "agent.message", message: id });
const prose = (id: string) =>
  Item.parse({
    id,
    agentId: "root",
    type: "message",
    role: "assistant",
    parts: [{ type: "text", text: id }],
    createdAt: ++created,
    complete: true,
  });
const thought = (id: string, text: string, complete = true) =>
  Item.parse({ id, agentId: "root", type: "reasoning", text, complete, createdAt: ++created });
const facts = (items: Item[]) => {
  const retried = retriedStepIds(items);
  return items.flatMap((item) => stepFact(item, retried) ?? []);
};

it("exploration alone reads as files explored and searches, counting each file once", () => {
  const { groups } = groupSteps(
    facts([read("a"), search("q"), read("b"), read("a2", "a.ts"), shell("rg", "rg -n seq apps")]),
  );
  expect(groups).toHaveLength(1);
  expect(groups[0]).toMatchObject({
    single: false,
    explore: true,
    summary: "Explored 2 files and 2 searches",
    icon: "explore",
    newest: "rg",
  });
});

it("a mixed summary names at most two kinds, changes first, and counts the rest", () => {
  const summary = groupSummary(
    facts([
      read("a"),
      edit("e1", "a.ts"),
      shell("test", "bun run test"),
      edit("e2", "b.ts"),
      search("q"),
      call("plan", { kind: "plan", todos: [] }),
    ]),
  );
  expect(summary).toBe("Edited 2 files, ran 1 command and 3 other steps");
});

it("consecutive tool steps merge into one row, whatever each one did", () => {
  const { groups } = groupSteps(
    facts([
      shell("install", "bun install"),
      shell("peek", "sed -n 1,40p src/a.ts"),
      shell("test", "bun run test"),
      shell("find", "rg -n seq src"),
      edit("e1", "a.ts"),
      shell("lint", "bun run lint"),
    ]),
  );
  expect(groups.map((group) => group.ids)).toEqual([
    ["install", "peek", "test", "find", "e1", "lint"],
  ]);
  expect(groups[0]?.single).toBe(false);
});

it("launching or messaging other agents never folds into the tools around it", () => {
  const { groups } = groupSteps(
    facts([
      read("a"),
      spawn("reviewer"),
      spawn("tester"),
      tell("ping"),
      shell("test", "bun run test"),
      read("b"),
    ]),
  );
  expect(groups.map((group) => group.ids)).toEqual([
    ["a"],
    ["reviewer", "tester", "ping"],
    ["test", "b"],
  ]);
});

it("a thought between steps stays in their group", () => {
  const { groups } = groupSteps(
    facts([read("a"), thought("why", "Check the caller too."), read("b"), spawn("helper")]),
  );
  expect(groups.map((group) => group.ids)).toEqual([["a", "why", "b"], ["helper"]]);
  expect(groups[0]?.sentence).toBe("Read 2 files and thought once");
});

it("an error ends the group before it, even between steps that would merge", () => {
  const notice = Item.parse({
    id: "err",
    agentId: "root",
    type: "notice",
    level: "error",
    text: "Tool failed",
    complete: true,
    createdAt: ++created,
  });
  const { groups } = groupSteps(
    facts([shell("x", "bun install"), notice, shell("y", "bun run build")]),
  );
  expect(groups.map((group) => group.ids)).toEqual([["x"], ["err"], ["y"]]);
  expect(groups.every((group) => group.single)).toBe(true);
});

it("what the agent says between steps stands alone and splits the groups", () => {
  const { groups } = groupSteps(
    facts([
      read("a"),
      read("b"),
      prose("note"),
      shell("x", "bun install"),
      shell("y", "bun run build"),
    ]),
  );
  expect(groups.map((group) => [group.ids, group.single])).toEqual([
    [["a", "b"], false],
    [["note"], true],
    [["x", "y"], false],
  ]);
  expect(groups[2]?.summary).toBe("Ran 2 commands");
  expect(groups[2]?.icon).toBe("command");
});

it("another agent's steps start their own group", () => {
  const { groups } = groupSteps(
    facts([read("a"), call("b", { kind: "file.read", path: "b.ts" }, { agent: "child" })]),
  );
  expect(groups.map((group) => group.ids)).toEqual([["a"], ["b"]]);
});

it("a failure retried with success is not counted as failed", () => {
  const { groups } = groupSteps(
    facts([
      shell("first", "bun run test", "failed"),
      shell("again", "bun run test"),
      shell("lint", "bun run lint", "failed"),
    ]),
  );
  expect(groups[0]?.summary).toBe("Ran 3 commands · 1 failed");
  expect(groups[0]?.failed).toBe(1);
});

it("browser and computer-use steps count sites visited and app steps", () => {
  const browse = (id: string, url: string) =>
    call(id, { kind: "mcp", server: "ace", tool: "browser_open", arguments: { url } });
  const summary = groupSummary(
    facts([
      browse("one", "https://vercel.com/docs"),
      browse("two", "https://github.com/a"),
      browse("three", "https://github.com/b"),
      call("click", {
        kind: "mcp",
        server: "ace",
        tool: "screen_input",
        arguments: { action: "click" },
      }),
    ]),
  );
  expect(summary).toBe("Used 1 app and visited 2 sites");
});

it("appending a step builds only the last run again; earlier rows stay the same objects", () => {
  const steps: StepFact[] = facts([
    read("a"),
    read("b"),
    prose("between"),
    shell("x", "bun install", "running"),
  ]);
  const first = groupSteps(steps);
  const appended = groupSteps(
    [...steps, ...facts([shell("y", "bun run build", "running")])],
    first,
  );
  expect(appended.groups[0]).toBe(first.groups[0]);
  expect(appended.groups[1]).toBe(first.groups[1]);
  // The run in flight is built again, but its unchanged row reads as before and stays.
  expect(appended.groups[2]).toBe(first.groups[2]);
  expect(appended.groups.slice(2).map((group) => group.ids)).toEqual([["x"], ["y"]]);
  // Nothing changed: the same grouping comes back.
  expect(groupSteps(appended.facts, appended)).toBe(appended);
});

it("a step settling regroups from its run on and keeps its summary current", () => {
  const running = facts([shell("a", "bun run lint"), shell("x", "bun install", "running")]);
  const before = groupSteps(running);
  const after = groupSteps(facts([shell("a", "bun run lint"), shell("x", "bun install")]), before);
  expect(before.groups.map((group) => group.running)).toEqual([false, true]);
  expect(after.groups).toHaveLength(1);
  expect(after.groups[0]).toMatchObject({ running: false, summary: "Ran 2 commands" });
});

it("regrouping a log from an earlier grouping reads as grouping it afresh", () => {
  const log = [
    read("a"),
    shell("b", "bun run lint"),
    shell("c", "bun run test", "running"),
    prose("between"),
    shell("d", "git status"),
    edit("e", "src/a.ts"),
    shell("f", "bun run build", "running"),
    shell("g", "bun run slow", "running"),
  ];
  const fresh = groupSteps(facts(log));
  // Grown one step at a time, each grouping built on the one before.
  let grown = groupSteps([]);
  for (let count = 1; count <= log.length; count++)
    grown = groupSteps(facts(log.slice(0, count)), grown);
  expect(grown.groups).toEqual(fresh.groups);
  // Settling the middle command regroups from its run on, to the same rows as a fresh read.
  const settled = log.map((item) => (item.id === "c" ? shell("c", "bun run test") : item));
  expect(groupSteps(facts(settled), grown).groups).toEqual(groupSteps(facts(settled)).groups);
});

it("thoughts count with the tools around them; a finished thought with no words is no step", () => {
  const { groups } = groupSteps(
    facts([
      shell("a", "bun install"),
      thought("empty", ""),
      shell("b", "bun run build"),
      thought("why", "The build needs the generated types first."),
      thought("still", "Checking the output.", false),
    ]),
  );
  // A thought still under way stands apart like any step in flight, and folds in once done.
  expect(groups.map((group) => group.ids)).toEqual([["a", "b", "why"], ["still"]]);
  expect(groups.map((group) => group.running)).toEqual([false, true]);
  expect(groups[0]?.summary).toBe("Ran 2 commands and thought once");
});

it("a thought in view on its own stays its own row when steps follow it", () => {
  const steps = [thought("plan", "Read the router first."), read("a"), shell("b", "bun test")];
  const alone = groupSteps(facts(steps.slice(0, 1)));
  const grown = groupSteps(facts(steps), alone);
  expect(grown.groups.map((group) => group.ids)).toEqual([["plan"], ["a", "b"]]);
  // The thought's row is the same object: appending steps did not rebuild it.
  expect(grown.groups[0]).toBe(alone.groups[0]);
});

it("a mixed group names two kinds as a sentence: commands and a file read", () => {
  expect(
    groupSummary(
      facts([
        shell("a", "bun install"),
        shell("b", "bun run build"),
        read("r"),
        shell("c", "bun run lint"),
      ]),
    ),
  ).toBe("Ran 3 commands and read 1 file");
});

it("a group of one kind shows that kind's icon: listings show the listing icon", () => {
  const { groups } = groupSteps(facts([shell("a", "ls apps"), shell("b", "ls packages")]));
  expect(groups[0]).toMatchObject({ icon: "list", explore: true });
});

it("a shell search with no matches never fails its group", () => {
  const { groups } = groupSteps(
    facts([
      shell("miss-1", "rg -n 'missing-symbol' src", "failed"),
      shell("miss-2", "grep -rn foo src", "failed"),
      shell("test", "bun run test", "failed"),
    ]),
  );
  // One row; only the command that failed counts against it.
  expect(groups.map((group) => group.ids)).toEqual([["miss-1", "miss-2", "test"]]);
  expect(groups.map((group) => group.failed)).toEqual([1]);
});

it("only shell searches failing reads as a quiet group", () => {
  const { groups } = groupSteps(
    facts([
      shell("miss-1", "rg -n 'missing-symbol' src", "failed"),
      shell("miss-2", "ls src", "failed"),
    ]),
  );
  expect(groups[0]?.failed).toBe(0);
  expect(groups[0]?.summary).toBe("Explored 1 search and 1 folder");
});

it("a question the agent asked is its own row, and questions asked back to back count as such", () => {
  const { groups } = groupSteps(
    facts([read("a"), ask("q1"), thought("t", "Now the quotes"), ask("q2"), ask("q3"), read("b")]),
  );
  expect(groups.map((group) => group.ids)).toEqual([["a"], ["q1"], ["t"], ["q2", "q3"], ["b"]]);
  expect(groups[3]?.summary).toBe("Asked 2 questions");
});

it("commands left running in the background are a row of their own, never counted as commands", () => {
  const background = new Set(["dev", "watch"]);
  const steps = facts([
    shell("build", "bun run build"),
    shell("dev", "bun run dev"),
    shell("watch", "bun run watch"),
    thought("next", "Check the server."),
    shell("curl", "curl localhost:3000"),
  ]).map((fact) => (background.has(fact.id) ? backgroundFact(fact) : fact));
  const { groups } = groupSteps(steps);
  expect(groups.map((group) => group.ids)).toEqual([
    ["build"],
    ["dev", "watch"],
    ["next"],
    ["curl"],
  ]);
  expect(groups[1]).toMatchObject({ icon: "background", sentence: "Ran 2 background tasks" });
  expect(groups.map((group) => group.summary).join(" ")).not.toMatch(/commands/);
});

const pending = (id: string, detail: ToolDetail) => call(id, detail, { status: "running" });
const rows = (items: Item[]) =>
  groupSteps(facts(items)).groups.map((group) =>
    group.single ? `${group.running ? "running" : "done"} ${group.key}` : group.summary,
  );

it.each([
  {
    behaviour: "a running command stands apart from the commands that already ran",
    log: [
      shell("a", "bun install"),
      shell("b", "bun run build"),
      shell("c", "bun run lint", "running"),
    ],
    rows: ["Ran 2 commands", "running c"],
  },
  {
    behaviour: "a finished command folds into the group before it",
    log: [shell("a", "bun install"), shell("b", "bun run build"), shell("c", "bun run lint")],
    rows: ["Ran 3 commands"],
  },
  {
    behaviour: "with no group yet, one finished command is its own row beside the running one",
    log: [shell("a", "python3 -"), shell("b", "bun run lint", "running")],
    rows: ["done a", "running b"],
  },
  {
    behaviour: "two commands running at once are two rows after the ones that ran",
    log: [
      shell("a", "bun install"),
      shell("b", "bun run build"),
      shell("c", "bun run lint", "running"),
      shell("d", "bun run slow", "running"),
    ],
    rows: ["Ran 2 commands", "running c", "running d"],
  },
  {
    behaviour: "a step that finished after one still running joins the group before it",
    log: [
      shell("a", "bun install"),
      shell("b", "bun run lint", "running"),
      shell("c", "bun run build"),
    ],
    rows: ["Ran 2 commands", "running b"],
  },
  {
    behaviour: "an edit in flight stands apart from the edits that are done",
    log: [edit("a", "src/a.ts"), edit("b", "src/b.ts"), pending("c", editDetail("src/c.ts"))],
    rows: ["Edited 2 files", "running c"],
  },
  {
    behaviour: "a read in flight stands apart from what was explored",
    log: [read("a"), search("b"), search("c"), pending("d", { kind: "file.read", path: "d.ts" })],
    rows: ["Explored 1 file and 2 searches", "running d"],
  },
  {
    behaviour: "a search in flight stands apart from the searches that are done",
    log: [search("a"), search("b"), pending("c", { kind: "search", query: "c" })],
    rows: ["Explored 2 searches", "running c"],
  },
  {
    behaviour: "a mixed group keeps its sentence while a command runs after it",
    log: [edit("a", "src/a.ts"), shell("b", "bun run lint"), shell("c", "bun test", "running")],
    rows: ["Edited 1 file and ran 1 command", "running c"],
  },
  {
    behaviour: "a subagent launch in flight stands apart from the launches, never in the tools",
    log: [
      shell("a", "bun install"),
      spawn("b"),
      spawn("c"),
      pending("d", { kind: "agent.spawn", description: "d" }),
    ],
    rows: ["done a", "Started 2 subagents", "running d"],
  },
])("$behaviour", (row) => {
  expect(rows(row.log)).toEqual(row.rows);
});

it("a step waiting on approval stands apart like any step in flight", () => {
  const waiting = Item.parse({
    id: "c",
    agentId: "root",
    type: "tool_call",
    createdAt: ++created,
    complete: false,
    call: {
      id: "c",
      agentId: "root",
      kind: "shell",
      title: "c",
      status: "awaiting_approval",
      startedAt: created,
      detail: { kind: "shell", command: "rm -rf dist" },
      raw: [],
    },
  });
  expect(rows([shell("a", "bun install"), shell("b", "bun run build"), waiting])).toEqual([
    "Ran 2 commands",
    "running c",
  ]);
});

it("commands left running in the background keep one card, running or not", () => {
  const steps = facts([shell("a", "bun run dev", "running"), shell("b", "bun run watch")]).map(
    backgroundFact,
  );
  const { groups } = groupSteps(steps);
  expect(groups.map((group) => group.ids)).toEqual([["a", "b"]]);
  expect(groups[0]).toMatchObject({ icon: "background", running: true });
});
