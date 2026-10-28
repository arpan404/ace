import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import type { Fact } from "@ace/core";
import type { SubagentInspection } from "@ace/ui-core/mobile";
import { commands, connect, fixture, latest, open, reset, rows, until } from "./thread-harness.ts";
import { SubagentRetries } from "./subagent-retries.ts";

/*
 * A native subagent's lane as the phone inspects it, over the real SDK and an in-process fake
 * daemon (`thread-harness.ts`): what its parent asked, where its branch stands, its requests,
 * and Ask parent to retry. No provider CLI runs.
 */

afterEach(reset);

const spawn = (item: string, child: string, prompt: string): Fact =>
  facts.tool("root", item, {
    kind: "agent.spawn",
    title: "Review PID reuse",
    detail: { kind: "agent.spawn", description: "Review PID reuse", prompt, childAgent: child },
  });

type Lane = Omit<SubagentInspection, "prompt" | "retry"> & {
  retry: { label: string; asked: "queued" | "sent" | "pending" | null } | null;
  prompt: { at: number; bubble: { segments: { text: string }[]; long: boolean } } | null;
};
/** The lane info Swift holds for an agent, once the bridge has sent it. */
const info = (agentId: string) => {
  const frame = latest("thread.laneInfo");
  return frame?.lane === agentId ? ((frame.info as Lane | null) ?? undefined) : undefined;
};

async function laneOf(threadId: string, seed: Fact[], retries?: SubagentRetries) {
  const fake = fixture();
  fake.createThread({ id: threadId, workspaceId: "ace", title: "Tree", provider: "codex" });
  fake.apply(threadId, seed);
  const owner = connect(fake);
  const thread = open(owner, threadId, undefined, retries);
  // The subagent's id is the daemon's; its name finds it in the transcript's group.
  const agentId = await until(() => agentIdNamed("Reviewer"), "the reviewer's id");
  thread.handle({ type: "lane.open", agentId });
  return { fake, thread, agentId, owner };
}

/** The agent id of a subagent row the transcript shows, by title. */
function agentIdNamed(title: string): string | undefined {
  for (const block of rows("thread.block")) {
    const entries = (block.agents as { entries?: { title: string; agentId: string }[] } | undefined)
      ?.entries;
    const entry = entries?.find((candidate) => candidate.title === title);
    if (entry?.agentId) return entry.agentId;
  }
  return undefined;
}

test("a failed subagent shows what it was asked and offers Ask parent to retry, which queues one message for the main agent", async () => {
  const { thread, agentId } = await laneOf("failed", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    facts.message("root", "ask", "user", "Review it."),
    spawn("spawn", "reviewer", "Check whether a reused PID can kill the wrong process."),
    facts.subagent("codex", "reviewer", "Reviewer", "spawn"),
    facts.turn("reviewer", "spawn"),
    facts.endTurn("reviewer", "failed", { kind: "provider", message: "Rate limited" }),
    facts.endTurn("root"),
  ]);
  const failed = await until(() => info(agentId), "the lane's info");
  expect(failed.prompt?.bubble.segments.map((segment) => segment.text).join("")).toBe(
    "Check whether a reused PID can kill the wrong process.",
  );
  expect(failed.prompt?.bubble.long).toBe(false);
  expect(failed.phase).toBe("failed");
  expect(failed.working).toBe(false);
  expect(failed.status.token).toBe("failed");
  expect(failed.stoppable).toBe(false);
  expect(failed.retry).toEqual({ label: "Ask parent to retry", asked: null });
  thread.handle({ type: "lane.retry", agentId, requestId: "retry-1" });
  const [send] = await until(() => {
    const sent = commands("thread.send");
    return sent.length > 0 && sent;
  }, "the retry message");
  expect(send).toMatchObject({ threadId: "failed", delivery: "queue", trigger: "user" });
  const text = JSON.stringify(send?.input);
  expect(text).toContain("Reviewer");
  expect(text).toContain("Rate limited");
  // Asking is not a result: the subagent still reads failed until its parent runs it again.
  expect(info(agentId)?.phase).toBe("failed");
});

test("a subagent whose own child still works and asks the person reads waiting on you, offers Stop and no retry", async () => {
  const { agentId } = await laneOf("branch", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    spawn("spawn", "reviewer", "Review the tree."),
    facts.subagent("codex", "reviewer", "Reviewer", "spawn"),
    facts.turn("reviewer", "spawn"),
    facts.subagent("codex", "helper", "Helper", "spawn-helper", { parent: "reviewer" }),
    facts.turn("helper", "spawn"),
    // The reviewer's own turn ended well, but the helper under it still works and asks.
    facts.endTurn("reviewer"),
    {
      type: "interaction.opened",
      agent: "helper",
      interaction: "approve-rm",
      blocking: true,
      request: {
        kind: "question",
        questions: [
          {
            id: "clean",
            text: "Delete the build folder?",
            multiSelect: false,
            allowOther: false,
            secret: false,
            options: [
              { id: "yes", label: "Delete it" },
              { id: "no", label: "Keep it" },
            ],
          },
        ],
      },
    },
    facts.endTurn("root"),
  ]);
  const branch = await until(
    () => (info(agentId)?.requests.length ? info(agentId) : undefined),
    "the branch's request",
  );
  expect(branch.phase).toBe("human");
  expect(branch.status.token).toBe("needsYou");
  expect(branch.endedAt).toBeNull();
  expect(branch.descendants).toBe(1);
  expect(branch.stoppable).toBe(true);
  expect(branch.retry).toBeNull();
});

test("a subagent that finished well can't be retried: the request is refused and nothing is sent", async () => {
  const { thread, agentId } = await laneOf("done", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    spawn("spawn", "reviewer", "Review it."),
    facts.subagent("codex", "reviewer", "Reviewer", "spawn"),
    facts.turn("reviewer", "spawn"),
    facts.endTurn("reviewer"),
    facts.endTurn("root"),
  ]);
  const done = await until(() => info(agentId), "the lane's info");
  expect(done.phase).toBe("done");
  expect(done.retry).toBeNull();
  thread.handle({ type: "lane.retry", agentId, requestId: "retry-done" });
  const admission = await until(() => latest("admission", "retry-done"), "the refusal");
  expect(admission.ok).toBe(false);
  expect(commands("thread.send")).toHaveLength(0);
});

test("a subagent held by a usage limit reads Waiting, never working, and can't be retried yet", async () => {
  const { agentId } = await laneOf("limited", [
    facts.rootAgent("claude"),
    facts.turn("root"),
    spawn("spawn", "reviewer", "Review it."),
    facts.subagent("claude", "reviewer", "Reviewer", "spawn"),
    facts.turn("reviewer", "spawn"),
    facts.endTurn("reviewer", "failed", { kind: "quota", message: "Usage limit reached" }),
    facts.endTurn("root"),
  ]);
  const limited = await until(() => info(agentId), "the lane's info");
  expect(limited.status).toEqual({ label: "Waiting", token: "waiting" });
  expect(limited.working).toBe(false);
  expect(limited.endedAt).toBeNull();
  expect(limited.retry).toBeNull();
});

test("Stop counts only the subagents still at work under it, not the ones that ended", async () => {
  const { agentId } = await laneOf("stopcount", [
    facts.rootAgent("codex"),
    facts.turn("root"),
    spawn("spawn", "reviewer", "Review it."),
    facts.subagent("codex", "reviewer", "Reviewer", "spawn"),
    facts.turn("reviewer", "spawn"),
    facts.subagent("codex", "early", "Early", "spawn-early", { parent: "reviewer" }),
    facts.turn("early", "spawn"),
    facts.endTurn("early"),
    facts.subagent("codex", "late", "Late", "spawn-late", { parent: "reviewer" }),
    facts.turn("late", "spawn"),
    facts.endTurn("root"),
  ]);
  const running = await until(() => info(agentId), "the lane's info");
  expect(running.stoppable).toBe(true);
  expect(running.descendants).toBe(1);
});

const failedSeed = (): Fact[] => [
  facts.rootAgent("codex"),
  facts.turn("root"),
  spawn("spawn", "reviewer", "Review it."),
  facts.subagent("codex", "reviewer", "Reviewer", "spawn"),
  facts.turn("reviewer", "spawn"),
  facts.endTurn("reviewer", "failed", { kind: "provider", message: "stream closed" }),
  facts.endTurn("root"),
];

test("asking the parent twice sends one message, and the lane says it was asked, also after the thread is opened again", async () => {
  const retries = new SubagentRetries();
  const { thread, agentId, owner } = await laneOf("twice", failedSeed(), retries);
  await until(() => info(agentId)?.retry, "the retry offer");
  thread.handle({ type: "lane.retry", agentId, requestId: "retry-a" });
  thread.handle({ type: "lane.retry", agentId, requestId: "retry-b" });
  await until(() => latest("admission", "retry-b"), "the second press answered");
  await until(() => info(agentId)?.retry?.asked === "sent", "asked");
  expect(commands("thread.send")).toHaveLength(1);
  // A new visit to the thread keeps the ask: no button to press again.
  const again = open(owner, "twice", undefined, retries);
  again.handle({ type: "lane.open", agentId });
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(info(agentId)?.retry?.asked).toBe("sent");
  again.handle({ type: "lane.retry", agentId, requestId: "retry-c" });
  await until(() => latest("admission", "retry-c"), "the third press answered");
  expect(commands("thread.send")).toHaveLength(1);
});

test("once the subagent runs again and ends again, it can be asked about again; another agent ending changes nothing", async () => {
  const { fake, thread, agentId } = await laneOf("ended-again", [
    ...failedSeed().slice(0, -1),
    facts.subagent("codex", "other", "Other", "spawn-other"),
    facts.turn("other", "spawn"),
    facts.endTurn("root"),
  ]);
  await until(() => info(agentId)?.retry, "the retry offer");
  thread.handle({ type: "lane.retry", agentId, requestId: "retry-1" });
  await until(() => info(agentId)?.retry?.asked, "asked");
  // A different agent ending is not this one's new ending.
  fake.apply("ended-again", [facts.endTurn("other")]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  expect(info(agentId)?.retry?.asked).not.toBeNull();
  // Its parent ran it again and it failed again: a new ending, a new ask.
  fake.apply("ended-again", [
    { type: "turn.started", agent: "reviewer", nativeTurnId: "reviewer-turn-2", trigger: "spawn" },
    {
      type: "turn.ended",
      agent: "reviewer",
      nativeTurnId: "reviewer-turn-2",
      outcome: "failed",
      error: { kind: "provider", message: "stream closed again" },
    },
  ]);
  await until(() => info(agentId)?.retry?.asked === null && info(agentId), "asked cleared");
  thread.handle({ type: "lane.retry", agentId, requestId: "retry-2" });
  await until(() => commands("thread.send").length === 2, "a second message");
});
