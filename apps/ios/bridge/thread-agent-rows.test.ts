import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import { connect, fixture, open, reset, rows, until } from "./thread-harness.ts";

/*
 * The subagent and question rows the native transcript draws, worded as the web's: over the
 * real SDK and an in-process fake daemon (`thread-harness.ts`). No provider CLI runs.
 */

afterEach(reset);

const spawn = (id: string, title: string) =>
  facts.tool("root", id, {
    kind: "agent.spawn",
    title,
    detail: { kind: "agent.spawn", description: title },
  });

interface Agents {
  title: string;
  token: string;
  lead: { providers: string[]; more: number; label: string };
  since: number | null;
  entries: { title: string; label: string; meta: string; detail: string; detailKind: string }[];
}

test("a group of subagents leads with each provider once and rows say what each does now", async () => {
  const fake = fixture();
  fake.createThread({ id: "group", workspaceId: "ace", title: "Group", provider: "codex" });
  fake.apply("group", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Split it up."),
    spawn("s1", "Explore"),
    spawn("s2", "Test"),
    spawn("s3", "Review"),
    facts.subagent("codex", "explorer", "Explorer", "s1", { model: "gpt-5.5" }),
    facts.subagent("codex", "tester", "Tester", "s2"),
    facts.subagent("claude", "reviewer", "Reviewer", "s3"),
    facts.turn("explorer", "spawn"),
    facts.tool("explorer", "grep", {
      kind: "search",
      title: "Search for spawn(",
      detail: { kind: "search", query: "spawn(" },
    }),
    facts.turn("tester", "spawn"),
    facts.endTurn("tester"),
    facts.turn("reviewer", "spawn"),
  ]);
  open(connect(fake), "group");
  const group = await until(() => {
    const block = rows("thread.block").find((row) => row.kind === "subagents");
    const agents = block?.agents as Agents | undefined;
    return agents?.entries.length === 3 ? agents : undefined;
  }, "a group of three");
  expect(group.title).toBe("3 subagents");
  expect(group.lead.providers).toEqual(["codex", "claude"]);
  expect(group.lead.more).toBe(0);
  // Still running: it never reads done while any branch works, and its time ticks.
  expect(group.token).toBe("working");
  expect(group.since).not.toBeNull();
  const explorer = group.entries.find((entry) => entry.title === "Explorer");
  expect(explorer?.label).toBe("Running");
  expect(explorer?.meta).toBe("GPT-5.5");
  expect(explorer).toMatchObject({ detail: "Search for spawn(", detailKind: "live" });
  expect(group.entries.find((entry) => entry.title === "Tester")?.label).toBe("Done");
});

const indent = {
  id: "indent",
  text: "Tabs or spaces?",
  options: [
    { id: "tabs", label: "Tabs" },
    { id: "spaces", label: "Spaces" },
  ],
  multiSelect: false,
  allowOther: false,
  secret: false,
};

test("a waiting question reads as the agent asking it, then leaves for the work log once answered", async () => {
  const fake = fixture();
  fake.createThread({ id: "ask", workspaceId: "ace", title: "Ask", provider: "codex" });
  fake.apply("ask", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Set up the formatter."),
    facts.tool("root", "ask-indent", {
      kind: "ask_user",
      title: "Tabs or spaces?",
      detail: { kind: "ask_user" },
    }),
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "indent",
      item: "ask-indent",
      blocking: true,
      request: { kind: "question", questions: [indent] },
    },
  ]);
  open(connect(fake), "ask");
  const line = () =>
    rows("thread.block").find((row) => row.kind === "question")?.question as
      | { asking: boolean; asker: string; title: string; answer: string; outcome: string }
      | undefined;
  const asking = await until(line, "the question line");
  expect(asking).toEqual({
    asking: true,
    asker: "Codex",
    title: "Tabs or spaces?",
    answer: "",
    outcome: "",
  });
  fake.apply("ask", [
    {
      type: "interaction.closed",
      interaction: "indent",
      state: "resolved",
      resolution: { kind: "question", answers: { indent: ["spaces"] } },
    },
  ]);
  // Once answered, its step reads in the turn's work log, as on the web.
  await until(() => !line(), "the question line leaving");
  expect(rows("thread.block").some((row) => row.kind === "work")).toBe(true);
});
