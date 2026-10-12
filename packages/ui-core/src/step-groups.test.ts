import { Item, type ToolDetail } from "@ace/protocol";
import { expect, it } from "vitest";
import { groupSteps, groupSummary, retriedStepIds, stepFact, type StepFact } from "./index.ts";

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
const edit = (id: string, path: string) =>
  call(id, { kind: "file.edit", changes: [{ path, kind: "update", diff: "@@ -1 +1 @@\n-a\n+b" }] });
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

it("a mixed group names at most two kinds, changes first, and counts the rest", () => {
  const { groups } = groupSteps(
    facts([
      read("a"),
      edit("e1", "a.ts"),
      shell("test", "bun run test"),
      edit("e2", "b.ts"),
      search("q"),
      call("plan", { kind: "plan", todos: [] }),
    ]),
  );
  expect(groups[0]?.summary).toBe("Edited 2 files, ran 1 command and 3 other steps");
  expect(groups[0]?.icon).toBe("mixed");
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
    call(id, { kind: "mcp", server: "ace", tool: "ace_browser_open", arguments: { url } });
  const summary = groupSummary(
    facts([
      browse("one", "https://vercel.com/docs"),
      browse("two", "https://github.com/a"),
      browse("three", "https://github.com/b"),
      call("click", { kind: "mcp", server: "ace", tool: "screen_click", arguments: {} }),
    ]),
  );
  expect(summary).toBe("Used 1 app and visited 2 sites");
});

it("appending a step builds only the last group again; earlier groups stay the same objects", () => {
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
  expect(appended.groups[2]?.ids).toEqual(["x", "y"]);
  expect(appended.groups[2]).toMatchObject({ running: true, newest: "y" });
  // Nothing changed: the same grouping comes back.
  expect(groupSteps(appended.facts, appended)).toBe(appended);
});

it("a step settling regroups from its group on and keeps its summary current", () => {
  const running = facts([read("a"), shell("x", "bun install", "running")]);
  const before = groupSteps(running);
  const after = groupSteps(facts([read("a"), shell("x", "bun install")]), before);
  expect(before.groups[0]?.running).toBe(true);
  expect(after.groups[0]?.running).toBe(false);
});

it("a thought reads on its own row; a finished thought with no words is no step", () => {
  const { groups } = groupSteps(
    facts([
      shell("a", "bun install"),
      thought("empty", ""),
      shell("b", "bun run build"),
      thought("why", "The build needs the generated types first."),
      thought("now", "", false),
    ]),
  );
  expect(groups.map((group) => group.ids)).toEqual([["a", "b"], ["why"], ["now"]]);
  expect(groups[2]?.running).toBe(true);
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
