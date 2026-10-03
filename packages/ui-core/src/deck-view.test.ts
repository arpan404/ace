import { WorkspaceId, type ConductorRunView } from "@ace/protocol";
import { expect, test } from "vitest";
import { cardStatus, deckRunSummary } from "./deck.ts";
import { deckTitle } from "./deck-gate.ts";
import { deckBrief, deckFromSummary, deckFromView, type DeckAccounts } from "./deck-view.ts";

const accounts: DeckAccounts = (id) =>
  id === "codex-personal" ? { label: "Codex · Personal", provider: "codex" } : undefined;

const node = (id: string, patch: Partial<ConductorRunView["dag"][number]> = {}) => ({
  id,
  title: id,
  dependencies: [],
  ...patch,
});
const lane = (patch: Partial<ConductorRunView["lanes"][number]>) => ({
  id: "lane",
  agentId: "agent-1",
  role: "worker" as const,
  workstream: "seq",
  account: "codex-personal",
  model: "gpt-5.3-codex",
  generation: 0,
  status: "working" as const,
  ...patch,
});
const view = (patch: Partial<ConductorRunView>): ConductorRunView => ({
  id: "relay",
  workspaceId: WorkspaceId.parse("ace"),
  goal: "Make every relay stream resumable. Clients reconnect without losing output.",
  phase: "running",
  spent: 3,
  budget: 50,
  plan: null,
  planApproved: true,
  needsUser: [],
  lanes: [],
  dag: [],
  truncated: false,
  ...patch,
});

test("a deck is titled by its goal's first sentence", () => {
  expect(deckTitle(view({}).goal)).toBe("Make every relay stream resumable");
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
      ],
    }),
    accounts,
  );
  const [seq, ack, cursor, docs] = run.cards;
  expect(seq?.state).toBe("merged");
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
  // An account the daemon doesn't list keeps its id and shows no provider.
  expect(ack?.lane?.reviewer?.account).toBe("claude-work");
  expect(ack?.lane?.reviewer?.provider).toBeUndefined();
  expect(cursor?.state).toBe("in_review");
  expect(docs?.state).toBe("planned");
  expect(docs?.note).toBe("Starts after ack, cursor.");
  expect(deckRunSummary(run)).toBe("Dealing · 2 lanes active");
});

test("a lane's newest generation replaces a retired one on its card", () => {
  const run = deckFromView(
    view({
      dag: [node("seq", { state: "working" })],
      lanes: [
        lane({ id: "old", generation: 0, model: "old-model", status: "failed" }),
        lane({ id: "new", generation: 1, model: "new-model", agentId: "agent-2" }),
      ],
    }),
    accounts,
  );
  expect(run.cards[0]?.lane?.worker?.detail).toBe("new-model");
  expect(run.cards[0]?.lane?.agentId).toBe("agent-2");
});

test("an escalation is the gate a deck shows before its plan or merge approval", () => {
  const run = deckFromView(
    view({
      dag: [node("ack", { title: "Client ack", state: "escalated" })],
      needsUser: [
        {
          id: "merge-1",
          kind: "merge",
          workstream: null,
          lane: null,
          generation: null,
          message: "Merge?",
        },
        {
          id: "esc-1",
          kind: "escalation",
          workstream: "ack",
          lane: null,
          generation: 2,
          message: "Review failed twice.",
        },
      ],
    }),
    accounts,
  );
  expect(run.gate).toEqual({
    id: "esc-1",
    kind: "escalation",
    title: "Escalated: Client ack",
    body: "Review failed twice.",
    workstream: "ack",
  });
  expect(run.gates).toBe(2);
  expect(run.cards[0] && cardStatus(run.cards[0], run).label).toBe("Waiting for you");
  expect(deckRunSummary(run)).toBe("Escalation needs you · 0 of 1 merged");
});

const phase = (patch: Partial<ConductorRunView>) => deckFromView(view(patch), accounts).phase;

test("the conductor's phases map to the deck's, and an execution error stops it", () => {
  expect(phase({ phase: "planning" })).toBe("planning");
  expect(phase({ phase: "running", dag: [node("a", { state: "working" })] })).toBe("dealing");
  expect(phase({ phase: "running", dag: [node("a", { state: "integrated" })] })).toBe("merging");
  expect(phase({ phase: "cancelling" })).toBe("cancelled");
  expect(phase({ phase: "done" })).toBe("merged");
  expect(phase({ executionError: "conductor_execution_failed" })).toBe("failed");
});

test("a deck known only from the list is partial until its view arrives", () => {
  const run = deckFromSummary({
    id: "relay",
    workspaceId: WorkspaceId.parse("ace"),
    goal: "Resumable relay streams",
    phase: "planning",
    spent: 0,
    budget: 10,
  });
  expect(run.partial).toBe(true);
  expect(run.cards).toEqual([]);
  expect(deckRunSummary(run)).toBe("Drafting the plan");
});
