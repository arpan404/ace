import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import {
  commands,
  connect,
  fixture,
  latest,
  native,
  open,
  reset,
  rows,
  sent,
  until,
} from "./thread-harness.ts";

/*
 * The thread screen's bridge messages over the real SDK and an in-process fake daemon
 * (`thread-harness.ts`). No provider CLI runs.
 */

afterEach(reset);

test("a finished turn folds its steps into one Worked for head with counts; its answer stays in view", async () => {
  const fake = fixture();
  fake.createThread({ id: "turn", workspaceId: "ace", title: "Turn", provider: "codex" });
  fake.apply("turn", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Fix the flaky test."),
    facts.tool("root", "read", {
      kind: "file.read",
      title: "Read queue.test.ts",
      detail: { kind: "file.read", path: "queue.test.ts" },
    }),
    facts.toolDone("root", "read"),
    facts.message("root", "answer", "assistant", "The test now pins the clock."),
    facts.endTurn("root"),
  ]);
  open(connect(fake), "turn");
  const work = await until(
    () => rows("thread.block").find((row) => row.kind === "work"),
    "a work block",
  );
  const items = rows("thread.item");
  const read = items.find((row) => row.type === "tool_call");
  const answer = items.find((row) => row.text === "The test now pins the clock.");
  expect(work.items).toEqual([read?.id]);
  expect(work.items).not.toContain(answer?.id);
  const summary = work.work as { label: string; counts: string; ongoing: boolean };
  expect(summary.label).toMatch(/^Worked for /);
  expect(summary.counts).toBe("Explored 1 file");
  expect(summary.ongoing).toBe(false);
  const kinds = rows("thread.block")
    .toSorted((a, b) => Number(a.index) - Number(b.index))
    .map((row) => row.kind);
  expect(kinds).toEqual(["user", "work", "message"]);
  expect(read?.step).toMatchObject({ verb: "Read" });
});

test("streaming text updates its item row alone and never re-sends blocks", async () => {
  const fake = fixture();
  fake.createThread({ id: "stream", workspaceId: "ace", title: "Stream", provider: "codex" });
  fake.apply("stream", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Go"),
    facts.message("root", "reply", "assistant", "Working", false),
  ]);
  open(connect(fake), "stream");
  await until(() => rows("thread.block").some((row) => row.kind === "message"), "the reply block");
  await new Promise((resolve) => setTimeout(resolve, 50));
  const before = native.frames.filter((frame) => frame.type === "thread.block").length;
  fake.apply("stream", [facts.stream("root", "reply", " on it")]);
  await until(
    () => rows("thread.item").some((row) => row.text === "Working on it"),
    "the streamed text",
  );
  expect(native.frames.filter((frame) => frame.type === "thread.block").length).toBe(before);
});

test("a subagent group reads working while its child still runs after the parent's turn ends", async () => {
  const fake = fixture();
  fake.createThread({ id: "tree", workspaceId: "ace", title: "Tree", provider: "codex" });
  fake.apply("tree", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Review it."),
    facts.tool("root", "spawn", {
      kind: "agent.spawn",
      title: "Review PID reuse",
      detail: { kind: "agent.spawn", description: "Review PID reuse", childAgent: "reviewer" },
    }),
    facts.subagent("codex", "reviewer", "Reviewer", "spawn"),
    facts.turn("reviewer", "spawn"),
    facts.endTurn("root"),
  ]);
  open(connect(fake), "tree");
  const group = await until(
    () => rows("thread.block").find((row) => row.kind === "subagents"),
    "a subagent group",
  );
  const agents = group.agents as {
    entries: { state: string; agentId: string }[];
    status: string;
    counts: { text: string; token: string }[];
  };
  expect(agents.entries).toHaveLength(1);
  expect(agents.entries[0]?.state).toBe("working");
  expect(agents.entries[0]?.agentId).not.toBe("");
  expect(agents.status).toBe("1 working");
  expect(agents.counts).toEqual([{ text: "1 working", token: "working" }]);
});

test("while the agent works a send queues by default and steers when the person asks", async () => {
  const fake = fixture();
  fake.createThread({ id: "busy", workspaceId: "ace", title: "Busy", provider: "codex" });
  fake.apply("busy", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Go"),
  ]);
  const thread = open(connect(fake), "busy");
  const controls = await until(
    () =>
      latest("thread.controls")?.row as
        | { busy: boolean; delivery: string; alternate: string }
        | undefined,
    "composer controls",
  );
  expect(controls).toMatchObject({ busy: true, delivery: "queue", alternate: "steer" });
  thread.handle({ type: "send", text: "Also run lint", opposite: false, requestId: "queue-1" });
  thread.handle({ type: "send", text: "Stop and explain", opposite: true, requestId: "steer-1" });
  await until(
    () => latest("admission", "steer-1")?.ok === true && latest("admission", "queue-1")?.ok,
    "admissions",
  );
  await until(() => commands("thread.send").length === 2, "both sends on the wire");
  expect(commands("thread.send").map((payload) => payload.delivery)).toEqual(["queue", "steer"]);
});

test("while the main agent only waits on its subagents a message goes in now", async () => {
  const fake = fixture();
  fake.createThread({ id: "wait", workspaceId: "ace", title: "Wait", provider: "codex" });
  fake.apply("wait", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Review it."),
    facts.tool("root", "spawn", {
      kind: "agent.spawn",
      title: "Review PID reuse",
      detail: { kind: "agent.spawn", description: "Review PID reuse", childAgent: "reviewer" },
    }),
    facts.subagent("codex", "reviewer", "Reviewer", "spawn"),
    facts.turn("reviewer", "spawn"),
    facts.endTurn("root"),
  ]);
  const thread = open(connect(fake), "wait");
  await until(
    () => (latest("thread.controls")?.row as { delivery?: string })?.delivery === "steer",
    "a send that goes in now",
  );
  thread.handle({ type: "send", text: "Also check the docs", opposite: false, requestId: "now-1" });
  await until(() => commands("thread.send").length === 1, "the send on the wire");
  expect(commands("thread.send")[0]?.delivery).toBe("steer");
});

test("Stop interrupts the whole tree of the running turn", async () => {
  const fake = fixture();
  fake.createThread({ id: "stop", workspaceId: "ace", title: "Stop", provider: "codex" });
  fake.apply("stop", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Go"),
  ]);
  const thread = open(connect(fake), "stop");
  await until(
    () => (latest("thread.controls")?.row as { canStop?: boolean })?.canStop,
    "Stop offered",
  );
  thread.handle({ type: "stop", requestId: "stop-1" });
  await until(() => commands("thread.interrupt").length === 1, "the interrupt");
  expect(commands("thread.interrupt")[0]).toMatchObject({ threadId: "stop", cascade: true });
});

test("a question answer is admitted only when it fits what was asked, and closes the card", async () => {
  const fake = fixture();
  fake.createThread({ id: "ask", workspaceId: "ace", title: "Ask", provider: "claude" });
  fake.apply("ask", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "scope",
      blocking: true,
      request: {
        kind: "question",
        questions: [
          {
            id: "archive",
            text: "Include the archived posts?",
            multiSelect: false,
            allowOther: true,
            secret: false,
            options: [
              { id: "yes", label: "Include them (Recommended)" },
              { id: "no", label: "Skip the archive" },
            ],
          },
        ],
      },
    },
  ]);
  const thread = open(connect(fake), "ask");
  const card = await until(
    () =>
      rows("thread.interaction").find((row) => row.kind === "question" && row.state === "pending"),
    "the question card",
  );
  const question = (
    card.questions as {
      id: string;
      options: { id: string; label: string; recommended: boolean }[];
    }[]
  )[0];
  expect(question?.options[0]).toMatchObject({
    id: "yes",
    label: "Include them",
    recommended: true,
  });
  const interactionId = String(card.id);
  thread.handle({
    type: "answer",
    interactionId,
    answers: { archive: ["yes", "no"] },
    dismissed: false,
    requestId: "two",
  });
  thread.handle({
    type: "answer",
    interactionId,
    answers: {},
    dismissed: false,
    requestId: "none",
  });
  await until(() => latest("admission", "none"), "refusals");
  expect(latest("admission", "two")?.ok).toBe(false);
  expect(latest("admission", "none")?.ok).toBe(false);
  thread.handle({
    type: "answer",
    interactionId,
    answers: { archive: [" Only 2024 "] },
    dismissed: false,
    requestId: "own",
  });
  await until(() => latest("admission", "own")?.ok, "the free-text answer admitted");
  await until(
    () =>
      rows("thread.interaction").find(
        (row) => row.id === interactionId && row.state === "resolved",
      ),
    "the canonical resolution",
  );
  const resolve = commands("interaction.resolve");
  expect(resolve).toHaveLength(1);
  expect(resolve[0]?.resolution).toEqual({ kind: "question", answers: { archive: ["Only 2024"] } });
});

test("an approval names Allow once, Always allow and Deny by the request's exact options", async () => {
  const fake = fixture();
  fake.createThread({
    id: "grant",
    workspaceId: "ace",
    title: "Grant",
    provider: "codex",
    access: "ask",
  });
  fake.apply("grant", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.tool("root", "push", {
      kind: "shell",
      title: "Codex wants to run a command",
      status: "awaiting_approval",
      detail: { kind: "shell", command: "git push origin fix/queue" },
    }),
    {
      type: "interaction.opened",
      agent: "root",
      interaction: "push",
      item: "push",
      blocking: true,
      request: {
        kind: "approval",
        title: "Codex wants to run a command",
        options: [
          { id: "deny-it", label: "Deny", kind: "deny" },
          { id: "session-grant", label: "Always here", kind: "allow_session" },
          { id: "once", label: "Allow", kind: "allow_once" },
        ],
      },
    },
  ]);
  open(connect(fake), "grant");
  const card = await until(
    () => rows("thread.interaction").find((row) => row.kind === "approval"),
    "the approval card",
  );
  const options = card.options as { id: string }[];
  const decisions = (card.decisions as { verb: string; option: number; scope: string }[]).map(
    (decision) => [decision.verb, options[decision.option]?.id, decision.scope],
  );
  expect(decisions).toEqual([
    ["allow_once", "once", ""],
    ["always_allow", "session-grant", "Always here"],
    ["deny", "deny-it", ""],
  ]);
  expect(card.command).toBe("git push origin fix/queue");
});

test("a refused send goes again once under its retry id and reaches the transcript", async () => {
  const fake = fixture();
  fake.createThread({ id: "again", workspaceId: "ace", title: "Again", provider: "codex" });
  fake.apply("again", [facts.rootAgent("codex"), facts.turn("root"), facts.endTurn("root")]);
  const owner = connect(fake);
  const thread = open(owner, "again");
  await until(() => latest("thread.controls"), "composer controls");
  thread.handle({ type: "send", text: "Refuse this once", opposite: false, requestId: "first" });
  const id = await until(() => {
    for (const text of sent) {
      const message = JSON.parse(text) as { type?: string; command?: { id?: string } };
      if (message.type === "command" && message.command?.id) return message.command.id;
    }
    return undefined;
  }, "the first attempt");
  await until(() => owner.pendingSend(id)?.state === "failed", "the refusal");
  thread.handle({ type: "retrySend", id, requestId: "again" });
  await until(() => latest("admission", "again")?.ok, "the retry admitted");
  await until(
    () => rows("thread.item").some((row) => row.role === "user" && row.text === "Refuse this once"),
    "the message in the transcript",
  );
  const attempts = sent.filter(
    (text) => text.includes('"type":"command"') && text.includes("Refuse this once"),
  );
  expect(
    attempts.map((text) => (JSON.parse(text) as { command: { id: string } }).command.id),
  ).toEqual([id, `${id}:retry`]);
  thread.handle({ type: "retrySend", id: `${id}:retry`, requestId: "twice" });
  await until(() => latest("admission", "twice"), "a second retry");
  expect(latest("admission", "twice")?.ok).toBe(false);
});

test("a queued follow-up shows above the composer and can be reworded, sent now or removed", async () => {
  const fake = fixture();
  fake.createThread({ id: "queued", workspaceId: "ace", title: "Queued", provider: "codex" });
  fake.apply("queued", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Go"),
  ]);
  const thread = open(connect(fake), "queued");
  await until(() => (latest("thread.controls")?.row as { busy?: boolean })?.busy, "a busy thread");
  type Queue = { label: string; messages: { id: string; text: string; delivery: string }[] };
  const queue = () => latest("thread.queue") as Queue | undefined;
  thread.handle({ type: "send", text: "Then run lint", opposite: false, requestId: "q1" });
  thread.handle({ type: "send", text: "And the docs", opposite: false, requestId: "q2" });
  await until(() => queue()?.messages.length === 2, "two queued messages");
  expect(queue()?.label).toBe("2 queued messages");
  expect(rows("thread.item").some((row) => row.text === "Then run lint")).toBe(false);
  const [first, second] = queue()?.messages ?? [];
  thread.handle({
    type: "queue",
    messageId: String(first?.id),
    change: { kind: "words", text: "Then run lint and tests" },
    requestId: "e1",
  });
  await until(() => queue()?.messages[0]?.text === "Then run lint and tests", "the new words");
  thread.handle({
    type: "queue",
    messageId: String(second?.id),
    change: { kind: "remove" },
    requestId: "r1",
  });
  await until(() => queue()?.messages.length === 1, "the removal");
  thread.handle({
    type: "queue",
    messageId: String(first?.id),
    change: { kind: "steer" },
    requestId: "s1",
  });
  await until(
    () => commands("queue.edit").some((payload) => payload.delivery === "steer"),
    "send now on the wire",
  );
  thread.handle({
    type: "queue",
    messageId: "not-queued",
    change: { kind: "remove" },
    requestId: "gone",
  });
  await until(() => latest("admission", "gone"), "a refusal");
  expect(latest("admission", "gone")?.ok).toBe(false);
});

test("a simulator step opens its device and a computer-use step opens computer use", async () => {
  const fake = fixture();
  fake.createThread({ id: "sim", workspaceId: "ace", title: "Sim", provider: "claude" });
  const simId = "ios:7d1b2c4e-5a6f-4e8d-9b0a-1c2d3e4f5a6b";
  fake.apply("sim", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    facts.tool("root", "tap", {
      kind: "mcp",
      title: "sim_act",
      detail: { kind: "mcp", server: "ace", tool: "sim_act", arguments: { simId, action: "tap" } },
    }),
    facts.tool("root", "click", {
      kind: "mcp",
      title: "screen_input",
      detail: { kind: "mcp", server: "ace", tool: "screen_input", arguments: { kind: "click" } },
    }),
  ]);
  open(connect(fake), "sim");
  const steps = await until(() => {
    const found = rows("thread.item").filter((row) => row.type === "tool_call");
    return found.length === 2 ? found : undefined;
  }, "both steps");
  const opens = steps.map((row) => (row.step as { opens: string } | null)?.opens);
  expect(opens).toEqual([`device:${simId}`, "computer"]);
});
