import { Agent, BackgroundTask, type AgentStatus, type ThreadStatus } from "@ace/protocol";
import { expect, test } from "vitest";
import { whyNotDone, type WhyInput } from "./why.ts";

const agent = (id: string, status: AgentStatus, name?: string): Agent =>
  Agent.parse({
    id,
    threadId: "t",
    parentId: id === "root" ? null : "root",
    origin: id === "root" ? "root" : "provider_subagent",
    native: { provider: "claude", nativeId: id },
    fidelity: "full",
    cwd: "/repo",
    status,
    background: false,
    createdAt: 0,
    ...(name ? { name } : {}),
  });
const shell = (id: string, status: BackgroundTask["status"]): BackgroundTask =>
  BackgroundTask.parse({
    id,
    agentId: "root",
    kind: "shell",
    title: "bun run dev",
    status,
    ambient: false,
    stoppable: true,
    startedAt: 0,
    raw: [],
  });
const working: AgentStatus = { state: "working", activity: "tool" };
const input = (status: ThreadStatus, patch: Partial<WhyInput> = {}): WhyInput => ({
  status,
  rootAgentId: "root",
  agents: [agent("root", { state: "idle" })],
  tasks: [],
  waitingOnYou: 0,
  ...patch,
});

test("names running subagents and an open shell, and what settles them", () => {
  const why = whyNotDone(
    input(
      { state: "working", agents: 3 },
      {
        agents: [
          agent("root", { state: "blocked", on: "subagents", refs: [] }),
          agent("a", working, "reconnect-audit"),
          agent("b", working, "regression-test"),
        ],
        tasks: [shell("s", "running")],
      },
    ),
  );
  expect(why.body).toBe(
    "Two subagents are still running and one background shell is open. The thread settles when both report back and the shell is stopped or finishes.",
  );
});

test("a question waiting for you comes first", () => {
  const why = whyNotDone(input({ state: "needs_you", interactions: 1 }, { waitingOnYou: 1 }));
  expect(why.body).toBe("One question is waiting for you. The thread settles when you answer it.");
});

test("a queued message holds an otherwise idle thread open", () => {
  expect(whyNotDone(input({ state: "waiting", on: "queue" })).body).toBe(
    "A queued message has not been sent yet. The thread settles when the queued message has been handled.",
  );
});

test("a task ace lost track of is called out as possibly running", () => {
  const why = whyNotDone(
    input({ state: "working", agents: 1 }, { tasks: [shell("s", "unknown")] }),
  );
  expect(why.body).toContain("One background task may still be running (ace lost track of it).");
});

test("a finished thread says so instead of explaining", () => {
  expect(whyNotDone(input({ state: "done" }))).toEqual({
    title: "Done",
    body: "Every agent has finished and nothing is running in the background.",
  });
});

test("a failed thread names the agent and its error", () => {
  const why = whyNotDone(
    input(
      { state: "failed" },
      {
        agents: [
          agent("root", { state: "idle" }),
          agent(
            "t",
            { state: "failed", error: { kind: "provider", message: "Context window exceeded" } },
            "migration-tester",
          ),
        ],
      },
    ),
  );
  expect(why).toEqual({
    title: "Failed",
    body: "migration-tester failed: Context window exceeded.",
  });
});
