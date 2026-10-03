import { ConductorRunView } from "@ace/protocol";
import type { FakeDeckCard, FakeDeckRun } from "./types.ts";

/*
 * The fake conductor's runs as the daemon publishes them (`ConductorRunView`): workstreams with
 * the conductor's node states, the live worker and reviewer lanes, and the open gate. The final
 * merge card is the fake's own; the daemon's merge decision is a gate, so it never reaches the
 * view.
 */

const nodeState: Record<Exclude<FakeDeckCard["state"], "merge">, string> = {
  planned: "pending",
  working: "working",
  fixing: "working",
  in_review: "reviewing",
  escalated: "escalated",
  merged: "integrated",
};

const laneStatus: Record<Exclude<FakeDeckCard["state"], "merge">, string> = {
  planned: "starting",
  working: "working",
  fixing: "working",
  in_review: "working",
  escalated: "waiting",
  merged: "done",
};

function phase(run: FakeDeckRun): ConductorRunView["phase"] {
  switch (run.phase) {
    case "merged":
      return "done";
    case "paused":
    case "cancelled":
    case "planning":
      return run.phase;
    default:
      return "running";
  }
}

function lanes(run: FakeDeckRun, cards: readonly FakeDeckCard[]) {
  return cards.flatMap((card) => {
    const lane = card.lane;
    if (!lane || card.state === "merge") return [];
    const generation = Math.max(card.round - 1, 0);
    const status = laneStatus[card.state];
    const agent = lane.threadId ?? `${run.id}.${card.id}`;
    return [
      {
        id: `${card.id}.worker`,
        agentId: agent,
        role: "worker",
        workstream: card.id,
        account: lane.worker.account,
        model: lane.worker.detail,
        generation,
        status,
      },
      {
        id: `${card.id}.reviewer`,
        agentId: `${agent}.review`,
        role: "reviewer",
        workstream: card.id,
        account: lane.reviewer.account,
        model: lane.reviewer.detail,
        generation,
        status: card.state === "in_review" ? "working" : status === "working" ? "waiting" : status,
      },
    ];
  });
}

/** One fake run as `conductor.result` and `conductor.changed` carry it. */
export function runView(run: FakeDeckRun): ConductorRunView {
  const work = run.cards.filter((card) => card.kind === "work");
  const ids = new Set(work.map((card) => card.id));
  const escalated = work.find((card) => card.state === "escalated");
  // The fake's goal reads like a person's: its title is the first sentence.
  const goal = run.goal.startsWith(run.title) ? run.goal : `${run.title}. ${run.goal}`;
  return ConductorRunView.parse({
    id: run.id,
    workspaceId: run.workspaceId,
    goal,
    phase: phase(run),
    spent: 0,
    budget: 0,
    plan: work.length
      ? {
          summary: goal,
          workstreams: work.map((card) => ({
            id: card.id,
            title: card.title,
            dependencies: card.dependencies.filter((dependency) => ids.has(dependency)),
            priority: 0,
            brief: {
              objective: card.title,
              instructions: card.note || card.title,
              acceptance: [card.title],
              files: [],
              packages: [],
              risks: [],
            },
          })),
        }
      : null,
    planApproved: run.planApproved,
    needsUser: run.gate
      ? [
          {
            id: run.gate.id,
            kind: run.gate.kind,
            workstream: run.gate.kind === "escalation" ? (escalated?.id ?? null) : null,
            lane: null,
            generation: run.gate.revision,
            message: run.gate.body.slice(0, 2048),
          },
        ]
      : [],
    lanes: lanes(run, work),
    dag: work.map((card) => ({
      id: card.id,
      title: card.title,
      dependencies: card.dependencies.filter((dependency) => ids.has(dependency)),
      state: card.state === "merge" ? "pending" : nodeState[card.state],
      fixRounds: Math.max(card.round - 1, 0),
      revision: card.state === "merged" ? "5d1f0c2a9b7e4d3c8a6f0e1b2c3d4e5f6a7b8c9d" : null,
    })),
    truncated: false,
  });
}
