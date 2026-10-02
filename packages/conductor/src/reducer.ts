import { laneDeadline } from "./liveness.ts";
import { ConductorSpec } from "@ace/protocol";
import { advance, cancel } from "./advance.ts";
import { approve } from "./approval.ts";
import { applyLaneStatus } from "./lane-status.ts";
import { admitOwnership, settle, validateReview } from "./completion.ts";
import { Fact, Key, type Environment, type State, type Transition } from "./schema.ts";
import { control, emptyState, gate } from "./transition.ts";
import type { Context } from "./transition.ts";

export function start(id: string, spec: unknown, env: Environment): Transition {
  const parsed = ConductorSpec.parse(spec);
  const ctx: Context = {
    state: emptyState(
      Key.parse(id),
      parsed,
      env.ownershipCase?.(parsed.workspaceId) ?? "insensitive",
    ),
    effects: [],
    env,
  };
  advance(ctx);
  return { state: ctx.state, effects: ctx.effects };
}
/** No I/O. Caller serializes facts and commits state plus effects atomically. */
export function reduce(state: State, input: unknown, env: Environment): Transition {
  const fact = Fact.parse(input);
  if (state.phase === "cancelled" || state.phase === "done") return { state, effects: [] };
  if (fact.type === "status") {
    const lane = state.lanes[fact.laneId];
    if (
      lane?.live &&
      lane.generation === fact.generation &&
      lane.status === "migrating" &&
      !lane.retiring
    ) {
      if (fact.at > env.now() || fact.at < lane.lastActivity) return { state, effects: [] };
      return {
        state: {
          ...state,
          lanes: {
            ...state.lanes,
            [lane.id]: {
              ...lane,
              lastActivity: fact.at,
              migrationObservation: { status: fact.status, at: fact.at },
            },
          },
        },
        effects: [],
      };
    }
  }
  // Activity does not change DAG readiness or release a reservation. Keep this
  // path proportional to the bounded lane index, without copying the plan or
  // scanning workstream history. Deadline enforcement is an explicit tick.
  if (fact.type === "status" && (fact.status === "working" || fact.status === "waiting")) {
    const lane = state.lanes[fact.laneId];
    if (
      !lane?.live ||
      lane.generation !== fact.generation ||
      fact.at > env.now() ||
      fact.at < lane.lastActivity ||
      ((lane.status === "limited" || lane.status === "migrating") && !lane.retiring)
    )
      return { state, effects: [] };
    return {
      state: {
        ...state,
        lanes: {
          ...state.lanes,
          [lane.id]: {
            ...lane,
            status: fact.status,
            lastActivity: fact.at,
            artifactDeadline: null,
          },
        },
      },
      effects: [],
    };
  }
  const s: State = {
    ...state,
    accounts: state.accounts.map((a) => ({ ...a })),
    lanes: Object.fromEntries(Object.entries(state.lanes).map(([k, l]) => [k, { ...l }])),
    nodes: Object.fromEntries(Object.entries(state.nodes).map(([k, n]) => [k, { ...n }])),
    gates: { ...state.gates },
  };
  const ctx: Context = { state: s, effects: [], env };
  if ("laneId" in fact) {
    const lane = s.lanes[fact.laneId];
    if (!lane || !lane.live || lane.generation !== fact.generation) return { state, effects: [] };
    const node = lane.workstream ? (s.nodes[lane.workstream] ?? null) : null;
    if (fact.type === "migrated") {
      if (lane.status !== "migrating") return { state, effects: [] };
      lane.status = lane.migrationObservation?.status ?? "working";
      lane.lastActivity = lane.migrationObservation?.at ?? env.now();
      lane.migrationObservation = null;
      applyLaneStatus(ctx, lane);
    } else if (fact.type === "status") {
      if (fact.at > env.now() || fact.at < lane.lastActivity) return { state, effects: [] };
      if ((lane.status === "limited" || lane.status === "migrating") && !lane.retiring)
        return { state, effects: [] };
      lane.status = fact.status;
      lane.lastActivity = fact.at;
      applyLaneStatus(ctx, lane);
    } else if (fact.type === "artifact") {
      if (lane.artifact || lane.retiring || lane.status === "limited")
        return { state, effects: [] };
      const expected =
        lane.role === "planner" ? "plan" : lane.role === "reviewer" ? "review" : "completion";
      if (fact.artifact.kind !== expected) throw new Error("wrong_lane_artifact");
      validateReview(s, lane, fact.artifact);
      lane.artifact =
        fact.artifact.kind === "plan"
          ? { kind: "plan", plan: admitOwnership(s, fact.artifact.plan) }
          : fact.artifact;
      settle(ctx, lane);
    } else if (fact.type === "usage_limit") {
      if (lane.retiring || lane.status === "limited") return { state, effects: [] };
      if (lane.status === "migrating")
        lane.migrationObservation = { status: "limited", at: env.now() };
      else lane.status = "limited";
      const account = s.accounts.find((a) => a.id === lane.account);
      if (account) account.quota = 0;
    } else if (fact.type === "destructive") gate(ctx, "destructive", fact.description, node, lane);
  } else
    switch (fact.type) {
      case "accounts":
        if (new Set(fact.accounts.map((a) => a.id)).size !== fact.accounts.length)
          throw new Error("duplicate_account");
        s.accounts = fact.accounts;
        break;
      case "approve":
        approve(ctx, fact.approval);
        break;
      case "pause":
        if (s.phase === "planning" || s.phase === "running") {
          s.beforePause = s.phase;
          s.phase = "paused";
          for (const lane of Object.values(s.lanes)) if (lane.live) control(ctx, lane, "pause");
        }
        break;
      case "resume":
        if (s.phase === "paused") {
          s.phase = s.beforePause;
          for (const lane of Object.values(s.lanes))
            if (lane.live && !lane.retiring && lane.status !== "limited")
              control(ctx, lane, "resume");
        }
        break;
      case "cancel":
        for (const id of Object.keys(s.gates)) {
          delete s.gates[id];
          ctx.effects.push({ type: "gate_closed", id: env.id(), gateId: id });
        }
        cancel(ctx);
        break;
      case "merge_result": {
        const node = s.nodes[fact.workstream];
        if (
          !node ||
          node.state !== "merging" ||
          s.integration !== node.id ||
          node.operation !== fact.operationId
        )
          return { state, effects: [] };
        if (fact.conflict) {
          node.state = "conflict_pending";
          node.conflict = fact.conflict;
          node.trivialConflict = fact.trivial;
          s.integration = null;
        } else {
          node.state = "verifying";
          node.mergedRevision = fact.revision;
          node.operation = env.id();
          ctx.effects.push({
            type: "verify",
            id: node.operation,
            workstream: node.id,
            revision: fact.revision,
            mode: s.spec.policies.merge === "PR-only" ? "pr" : "local",
          });
        }
        break;
      }
      case "verified": {
        const node = s.nodes[fact.workstream];
        if (
          !node ||
          node.state !== "verifying" ||
          s.integration !== node.id ||
          node.operation !== fact.operationId ||
          node.mergedRevision !== fact.revision
        )
          return { state, effects: [] };
        s.integration = null;
        if (fact.passed) {
          node.state = "integrated";
          node.conflict = null;
        } else {
          node.state = "escalated";
          if (s.phase !== "cancelling") gate(ctx, "escalation", fact.summary, node);
        }
        break;
      }
      case "tick":
        for (const lane of Object.values(s.lanes)) {
          const deadline = laneDeadline(s, lane);
          if (deadline === null || env.now() < deadline) continue;
          const missingArtifact = lane.status === "done";
          if (!missingArtifact) lane.status = "unresponsive";
          const node = lane.workstream ? (s.nodes[lane.workstream] ?? null) : null;
          if (node) node.state = "escalated";
          gate(
            ctx,
            "escalation",
            missingArtifact
              ? `Lane ${lane.id} is done without its ${lane.role} artifact`
              : `Lane ${lane.id} stalled`,
            node,
            lane,
          );
        }
        break;
    }
  advance(ctx);
  return { state: s, effects: ctx.effects };
}
