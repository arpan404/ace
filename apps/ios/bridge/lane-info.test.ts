import { afterEach, expect, test } from "vitest";
import { facts } from "@ace/fake-daemon";
import type { Fact } from "@ace/core";
import type { SubagentInspection } from "@ace/ui-core/mobile";
import { commands, connect, fixture, latest, open, reset, rows, until } from "./thread-harness.ts";

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

type Lane = Omit<SubagentInspection, "prompt"> & {
  prompt: { at: number; bubble: { segments: { text: string }[]; long: boolean } } | null;
};
/** The lane info Swift holds for an agent, once the bridge has sent it. */
const info = (agentId: string) => {
  const frame = latest("thread.laneInfo");
  return frame?.lane === agentId ? ((frame.info as Lane | null) ?? undefined) : undefined;
};

async function laneOf(threadId: string, seed: Fact[]) {
  const fake = fixture();
  fake.createThread({ id: threadId, workspaceId: "ace", title: "Tree", provider: "codex" });
  fake.apply(threadId, seed);
  const thread = open(connect(fake), threadId);
  // The subagent's id is the daemon's; its name finds it in the transcript's group.
  const agentId = await until(() => agentIdNamed("Reviewer"), "the reviewer's id");
  thread.handle({ type: "lane.open", agentId });
  return { fake, thread, agentId };
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
  expect(failed.retry).toEqual({ label: "Ask parent to retry" });
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
