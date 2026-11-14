import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import { HostId, ThreadId } from "@ace/protocol";
import { commands, connect, fixture, open, reset, rows, until } from "./thread-harness.ts";

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
  const question = await until(questionLine, "the question line");
  expect(question).toEqual({
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
  await until(() => !questionLine(), "the question line leaving");
  expect(rows("thread.block").some((row) => row.kind === "work")).toBe(true);
});

function questionLine() {
  return rows("thread.block").find((row) => row.kind === "question")?.question as
    | { asking: boolean; asker: string; title: string; answer: string; outcome: string }
    | undefined;
}
function asking(id: string, allowOther: boolean) {
  const fake = fixture();
  fake.createThread({ id, workspaceId: "ace", title: "Ask", provider: "codex" });
  fake.apply(id, [
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
      request: { kind: "question", questions: [{ ...indent, allowOther }] },
    },
  ]);
  return fake;
}

const pendingId = async () => {
  const block = await until(
    () => rows("thread.block").find((row) => row.kind === "question"),
    "the question",
  );
  return String(block.interactionId);
};

test("words sent while the agent waits on its question answer it, not the agent", async () => {
  const thread = open(connect(asking("reply", true)), "reply");
  const interactionId = await pendingId();
  thread.handle({
    type: "send",
    text: "Tabs, four wide",
    opposite: false,
    reply: { interactionId, picked: {}, written: {}, at: 0 },
    requestId: "reply-1",
  });
  const resolve = await until(() => commands("interaction.resolve")[0], "the answer");
  expect(resolve.resolution).toEqual({
    kind: "question",
    answers: { indent: ["Tabs, four wide"] },
  });
  expect(commands("thread.send")).toHaveLength(0);
});

test("words to a question that takes no free text go to the agent as a message", async () => {
  const thread = open(connect(asking("plain", false)), "plain");
  const interactionId = await pendingId();
  thread.handle({
    type: "send",
    text: "Why do you ask?",
    opposite: false,
    reply: { interactionId, picked: { indent: ["tabs"] }, written: {}, at: 0 },
    requestId: "plain-1",
  });
  await until(() => commands("thread.send")[0], "the message");
  expect(commands("interaction.resolve")).toHaveLength(0);
});

const delegated = (child: string, phase: "running" | "settled") => ({
  type: "item.upsert" as const,
  agent: "root",
  item: `delegation-${child}`,
  draft: {
    type: "delegation.started" as const,
    origin: "ace" as const,
    childThreadId: ThreadId.parse(child),
    provider: "codex" as const,
    title: "Relay protocol reference",
    role: "docs",
    phase,
    status:
      phase === "settled" ? { state: "done" as const } : { state: "working" as const, agents: 1 },
    updatedAt: phase === "settled" ? 2000 : 1000,
    generation: 0,
    complete: phase === "settled",
    outcome: null,
  },
});

test("a delegated child the thread list still shows working never reads done in its parent", async () => {
  const fake = fixture();
  // The child works on: the list has it as working.
  fake.createThread({
    id: "docs-child",
    workspaceId: "ace",
    title: "Relay protocol reference",
    provider: "codex",
  });
  fake.apply("docs-child", [facts.rootAgent("codex"), facts.turn("root")]);
  // The parent's own copy of the launch already says done (a stale card after a reconnect).
  fake.createThread({ id: "docs-parent", workspaceId: "ace", title: "Docs", provider: "codex" });
  fake.apply("docs-parent", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    delegated("docs-child", "settled"),
    facts.endTurn("root"),
  ]);
  open(connect(fake), "docs-parent");
  const group = await until(() => {
    const agents = rows("thread.block").find((row) => row.kind === "subagents")?.agents as
      | (Agents & { single: boolean })
      | undefined;
    return agents?.token === "working" ? agents : undefined;
  }, "the group at the list's state");
  expect(group.title).toBe("1 subagent");
  expect(group.single).toBe(true);
  // Once the child ends, the group says the launch ran.
  fake.apply("docs-child", [facts.endTurn("root")]);
  const ended = await until(() => {
    const agents = rows("thread.block").find((row) => row.kind === "subagents")?.agents as
      | Agents
      | undefined;
    return agents?.title === "1 subagent ran" ? agents : undefined;
  }, "the launch reads as ran");
  expect(ended.token).not.toBe("working");
});

test("a child delegated to another machine names that machine and its host, to open it there", async () => {
  const fake = fixture();
  fake.createThread({ id: "far-parent", workspaceId: "ace", title: "Far", provider: "codex" });
  const launch = delegated("far-child", "running");
  fake.apply("far-parent", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    {
      ...launch,
      draft: {
        ...launch.draft,
        machine: { machine: "m-studio", name: "Studio", hostId: HostId.parse("studio") },
      },
    },
  ]);
  open(connect(fake), "far-parent");
  const entry = await until(() => {
    const agents = rows("thread.block").find((row) => row.kind === "subagents")?.agents as
      | { entries: { threadId: string; machine: string; machineHost: string }[] }
      | undefined;
    return agents?.entries[0];
  }, "the delegated child's row");
  expect(entry).toMatchObject({ threadId: "far-child", machine: "Studio", machineHost: "studio" });
});
