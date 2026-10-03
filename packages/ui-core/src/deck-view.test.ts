import { ConductorRunView } from "@ace/protocol";
import { expect, test } from "vitest";
import { cardStatus, deckRunSummary, deckStepper } from "./deck.ts";
import type { DeckAccounts, DeckThreads } from "./deck-agents.ts";
import { deckErrorText, deckTitle } from "./deck-gate.ts";
import { deckBrief, deckFromSummary, deckFromView } from "./deck-view.ts";

const accounts: DeckAccounts = (id) =>
  id === "codex-personal" ? { label: "Codex · Personal", provider: "codex" } : undefined;

type Input = Record<string, unknown>;
const node = (id: string, patch: Input = {}) => ({ id, title: id, dependencies: [], ...patch });
const lane = (patch: Input) => ({
  id: "lane",
  agentId: "agent-1",
  role: "worker",
  workstream: "seq",
  account: "codex-personal",
  model: "gpt-5.3-codex",
  generation: 0,
  status: "working",
  ...patch,
});
const delegation = (patch: Input) => ({
  laneId: "lane",
  workstream: "seq",
  threadId: "thread-worker",
  agentId: "agent-worker",
  parentThreadId: "thread-root",
  parentAgentId: "agent-root",
  provider: "codex",
  account: "codex-personal",
  generation: 0,
  phase: "running",
  ...patch,
});
const gate = (patch: Input) => ({
  id: "gate",
  kind: "plan",
  workstream: null,
  lane: null,
  generation: null,
  message: "Approve?",
  gatedAt: 1_000,
  ...patch,
});
/** A view as the daemon sends it, parsed by the protocol so defaults apply as on the wire. */
const view = (patch: Input = {}): ConductorRunView =>
  ConductorRunView.parse({
    id: "relay",
    workspaceId: "ace",
    goal: "Make every relay stream resumable. Clients reconnect without losing output.",
    phase: "running",
    spent: 3,
    budget: 50,
    startedAt: 100,
    updatedAt: 900,
    plan: null,
    planApproved: true,
    needsUser: [],
    lanes: [],
    dag: [],
    truncated: false,
    ...patch,
  });

test("a deck is titled by its goal's first sentence", () => {
  expect(deckTitle(view().goal)).toBe("Make every relay stream resumable");
  expect(deckTitle("x".repeat(100))).toHaveLength(70);
  expect(deckTitle("Move to Codex app-server 0.48. Adopt its turn events.")).toBe(
    "Move to Codex app-server 0.48",
  );
  expect(deckBrief("Resumable streams. Survive restarts.", "Resumable streams")).toBe(
    "Survive restarts.",
  );
});

test("node states read as card states, and fix rounds become review rounds", () => {
  const run = deckFromView(
    view({
      dag: [
        node("seq", { state: "integrated", revision: "abcdef1234" }),
        node("ack", { state: "working", fixRounds: 1, dependencies: ["seq"] }),
        node("cursor", { state: "reviewing", dependencies: ["seq"] }),
        node("docs", { dependencies: ["ack", "cursor"] }),
      ],
      lanes: [
        lane({ workstream: "ack" }),
        lane({ id: "r", role: "reviewer", workstream: "ack", account: "claude-work" }),
        lane({ id: "c", workstream: "cursor" }),
      ],
    }),
    accounts,
  );
  const [seq, ack, cursor, docs] = run.cards;
  expect(seq?.note).toBe("Merged at abcdef1.");
  expect(ack && cardStatus(ack, run).label).toBe("Fixing, round 2");
  expect(ack?.lane?.rounds).toEqual([
    { label: "Round 1", verdict: "Changes required" },
    { label: "Round 2", verdict: "Fixing" },
  ]);
  expect(ack?.lane?.worker).toEqual({
    account: "Codex · Personal",
    provider: "codex",
    detail: "gpt-5.3-codex",
  });
  // An account the daemon doesn't list never shows its raw id.
  expect(ack?.lane?.reviewer?.account).toBe("Account removed");
  expect(cursor && cardStatus(cursor, run).label).toBe("In review");
  expect(docs?.note).toBe("Starts after ack, cursor.");
  expect(deckRunSummary(run)).toBe("Dealing · 2 lanes active");
});

test("a lane on the installed CLI's own login reads as that provider's default login", () => {
  const run = deckFromView(
    view({ dag: [node("seq", { state: "working" })], lanes: [lane({ account: "local.claude" })] }),
    accounts,
  );
  expect(run.cards[0]?.lane?.worker).toEqual({
    account: "Claude Code · default login",
    provider: "claude",
    detail: "gpt-5.3-codex",
  });
});

const threads: DeckThreads = (id) =>
  ({
    "thread-worker": { title: "Deck worker: seq", createdAt: 200, updatedAt: 400 },
    "thread-review": { title: "Deck reviewer: seq", createdAt: 450, updatedAt: 700 },
  })[id];

test("a card keeps its worker and reviewer after their lanes retire, named from their threads", () => {
  const run = deckFromView(
    view({
      dag: [node("seq", { state: "approved" })],
      delegations: [
        delegation({ laneId: "w", phase: "settled" }),
        delegation({
          laneId: "r",
          threadId: "thread-review",
          provider: "claude",
          account: "local.claude",
          phase: "settled",
        }),
      ],
    }),
    accounts,
    threads,
  );
  const card = run.cards[0];
  expect(card?.lane?.worker).toEqual({
    account: "Codex · Personal",
    provider: "codex",
    detail: "Finished",
  });
  expect(card?.lane?.reviewer?.account).toBe("Claude Code · default login");
  expect(card?.agents.map((agent) => [agent.label, agent.live])).toEqual([
    ["Reviewer", false],
    ["Worker", false],
  ]);
  expect([card?.startedAt, card?.updatedAt]).toEqual([200, 700]);
});

test("a delegate_task child is a sub-agent on its card, and the planner belongs to the deck", () => {
  const run = deckFromView(
    view({
      phase: "planning",
      planApproved: false,
      dag: [node("seq", { state: "working" })],
      lanes: [lane({ id: "w" })],
      delegations: [
        delegation({ laneId: "p", workstream: null, threadId: "thread-plan", phase: "settled" }),
        delegation({ laneId: "w" }),
        delegation({
          laneId: "w",
          threadId: "thread-child",
          agentId: null,
          parentThreadId: "thread-worker",
          parentAgentId: "agent-worker",
        }),
      ],
    }),
    accounts,
  );
  expect(run.agents.map((agent) => agent.label)).toEqual(["Planner"]);
  const agents = run.cards[0]?.agents ?? [];
  expect(agents.map((agent) => [agent.label, agent.nested])).toEqual([
    ["Worker", false],
    ["Sub-agent", true],
  ]);
  // The card opens the lane's own thread, never the child's.
  expect(run.cards[0]?.lane?.threadId).toBe("thread-worker");
});

test("a lane's newest generation replaces a retired one on its card", () => {
  const run = deckFromView(
    view({
      dag: [node("seq", { state: "working", fixRounds: 1 })],
      lanes: [
        lane({ id: "old", generation: 0, model: "old-model", status: "failed" }),
        lane({ id: "new", generation: 1, model: "new-model" }),
      ],
      delegations: [
        delegation({ laneId: "old", threadId: "thread-old", phase: "settled" }),
        delegation({ laneId: "new", threadId: "thread-new", generation: 1 }),
      ],
    }),
    accounts,
  );
  expect(run.cards[0]?.lane?.worker?.detail).toBe("new-model");
  expect(run.cards[0]?.lane?.threadId).toBe("thread-new");
  expect(run.cards[0]?.agents[0]?.label).toBe("Worker, round 2");
});

test("a card stopped on a person comes first: escalations, an agent's question, then budget and merges", () => {
  const run = deckFromView(
    view({
      dag: [
        node("ack", { title: "Client ack", state: "approved" }),
        node("seq", { title: "Sequence numbers", state: "working" }),
      ],
      needsUser: [
        gate({
          id: "merge-1",
          kind: "merge",
          workstream: "ack",
          message: `Merge deck/x at ${"a1b2c3d4e5".repeat(4)}`,
        }),
        gate({
          id: "ask-1",
          kind: "provider",
          workstream: "seq",
          message: "question needs your answer",
          interactionId: "interaction-1",
          threadId: "thread-worker",
          gatedAt: 500,
        }),
        gate({ id: "budget-1", kind: "budget", message: "Spent 50 of 50.", gatedAt: 900 }),
        gate({
          id: "esc-1",
          kind: "escalation",
          workstream: "ack",
          message: "Review failed twice.",
          gatedAt: 800,
        }),
      ],
    }),
    accounts,
  );
  expect(run.gates.map((entry) => [entry.id, entry.kind])).toEqual([
    ["esc-1", "escalation"],
    ["ask-1", "provider"],
    ["budget-1", "escalation"],
    ["merge-1", "merge"],
  ]);
  expect(run.gate?.title).toBe("Escalated: Client ack");
  const ask = run.gates[1];
  expect(ask?.title).toBe("Sequence numbers needs your answer");
  expect(ask?.body).toBe("The agent asked a question. It continues once you answer.");
  expect(ask?.interaction).toEqual({ threadId: "thread-worker", interactionId: "interaction-1" });
  expect(ask?.gatedAt).toBe(500);
  expect(run.gates[3]?.body).toBe(
    "Client ack passed review at a1b2c3d. Approve to merge it into the deck's branch.",
  );
  // Conductor gates are answered with conductor.approve; they carry no interaction.
  expect(run.gate?.interaction).toBeNull();
  const [ack, seq] = run.cards;
  expect(seq && cardStatus(seq, run).label).toBe("Waiting for you");
  expect(ack && cardStatus(ack, run).label).toBe("Waiting for you");
  expect(deckRunSummary(run)).toBe("Escalation needs you · 0 of 2 merged");
});

test("two open decisions of one kind are taken oldest first", () => {
  const run = deckFromView(
    view({
      needsUser: [
        gate({ id: "late", kind: "provider", gatedAt: 900, interactionId: "b", threadId: "t" }),
        gate({ id: "early", kind: "provider", gatedAt: 300, interactionId: "a", threadId: "t" }),
      ],
    }),
    accounts,
  );
  expect(run.gate?.id).toBe("early");
  expect(deckRunSummary(run)).toBe("An agent needs your answer · 0 of 0 merged");
});

test("the run carries the daemon's start and update times; an older daemon's view reads as 0", () => {
  const run = deckFromView(view(), accounts);
  expect([run.startedAt, run.updatedAt]).toEqual([100, 900]);
  const legacy = view({ startedAt: undefined, updatedAt: undefined });
  expect([legacy.startedAt, legacy.updatedAt, legacy.delegations]).toEqual([0, 0, []]);
});

const phase = (patch: Input) => deckFromView(view(patch), accounts).phase;

test("the conductor's phases map to the deck's, and an execution error stops it", () => {
  expect(phase({ phase: "planning" })).toBe("planning");
  expect(phase({ phase: "running", dag: [node("a", { state: "working" })] })).toBe("dealing");
  expect(phase({ phase: "running", dag: [node("a", { state: "integrated" })] })).toBe("merging");
  expect(phase({ phase: "cancelling" })).toBe("stopping");
  expect(phase({ phase: "cancelled" })).toBe("cancelled");
  expect(phase({ phase: "done" })).toBe("merged");
  expect(phase({ executionError: "conductor_execution_failed" })).toBe("failed");
});

test("a deck that is still stopping its lanes says so and holds its stepper", () => {
  const run = deckFromView(
    view({ phase: "cancelling", dag: [node("a", { state: "working" })] }),
    accounts,
  );
  expect(deckRunSummary(run)).toBe("Stopping its lanes");
  const stepper = deckStepper(run);
  expect(stepper.paused).toBe(true);
  expect(stepper.steps.at(-1)).toEqual({ label: "Stopping", state: "current" });
});

test("an execution error reads as a sentence, and an unknown one keeps its code", () => {
  expect(deckErrorText("deck_workspace_not_found")).toBe(
    "The deck's project is no longer on this daemon.",
  );
  expect(deckErrorText("deck_new_failure")).toBe(
    "The daemon couldn't run the deck's next step (deck_new_failure).",
  );
});

test("a deck known only from the list is partial until its view arrives", () => {
  const run = deckFromSummary({
    id: "relay",
    workspaceId: view().workspaceId,
    goal: "Resumable relay streams",
    phase: "planning",
    spent: 0,
    budget: 10,
  });
  expect(run.partial).toBe(true);
  expect(run.cards).toEqual([]);
  expect(deckRunSummary(run)).toBe("Drafting the plan");
});
