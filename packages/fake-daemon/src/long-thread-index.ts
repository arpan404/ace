import { accountSample, counterPolicy, countsTowardTurnUsage } from "@ace/usage/accounting";
import {
  agentThreadStatus,
  approvalAutoReviewed,
  turnIsSettled,
  turnActivityStatus,
  emptyTurnDigest,
  itemDigestContribution,
  itemMessagePreview,
  type DigestContribution,
} from "@ace/projection";
import type {
  DeliveryEvent,
  ThreadView,
  TurnSummary,
  TurnDigest,
  TurnSubagentSummary,
} from "@ace/protocol";

import {
  AggregateIndex,
  ChangeIndex,
  aggregateDigest,
  contributionAggregate,
  combineAggregates,
  emptyAggregate,
} from "./long-thread-aggregate.ts";

interface TurnRecord {
  summary: TurnSummary;
  contributions: Map<string, DigestContribution>;
  counters: Record<string, number>;
  reportedCounters: Record<string, number>;
  itemAggregate: AggregateIndex;
  agentAggregates: Map<string, AggregateIndex>;
  messages: AggregateIndex;
  settled?: { seq: number; at: number };
  agents: Set<string>;
}

/** Fake-mode derived data. Reads use these summaries rather than replaying the transcript. */
export class FakeTurnIndex {
  private changes = new Map<string, ChangeIndex>();
  private completedSeq = new Map<string, AggregateIndex>();
  private completedTime = new Map<string, AggregateIndex>();
  private threadMessages = new Map<string, AggregateIndex>();
  private itemSeqs = new Map<string, number>();
  private itemAgents = new Map<string, string>();
  private turns = new Map<string, Map<number, TurnRecord>>();
  private runs = new Map<string, number>();
  private agents = new Map<string, number>();
  private items = new Map<string, number>();
  private interactions = new Map<string, number>();
  private autoReviewed = new Map<string, boolean>();
  private current = new Map<string, number>();
  private usage = new Map<string, ReturnType<typeof accountSample>["next"]>();
  private usageKnown = new Set<string>();
  private agentRuns = new Map<string, string>();
  private agentStates = new Map<string, string>();

  private ensure(event: DeliveryEvent, ordinal: number): TurnRecord {
    let thread = this.turns.get(event.threadId);
    if (!thread) {
      thread = new Map();
      this.turns.set(event.threadId, thread);
    }
    let turn = thread.get(ordinal);
    if (!turn) {
      turn = {
        summary: {
          threadId: event.threadId,
          ordinal,
          startSeq: event.seq,
          endSeq: event.seq,
          startedAt: event.at,
          status: { state: "working", agents: 1 },
          outcome: "active",
          initiatingMessagePreview: "",
          latestAgentMessagePreview: "",
          digest: emptyTurnDigest(),
          subagents: [],
          subagentsTruncated: false,
        },
        contributions: new Map(),
        counters: {},
        reportedCounters: {},
        itemAggregate: new AggregateIndex(),
        agentAggregates: new Map(),
        messages: new AggregateIndex(),
        agents: new Set(),
      };
      thread.set(ordinal, turn);
    }
    return turn;
  }

  record(event: DeliveryEvent, view: ThreadView): void {
    const payload = event.payload;
    const threadId = event.threadId;
    let ordinal = this.current.get(threadId);
    let previousContribution: DigestContribution | undefined;
    let nextContribution: DigestContribution | undefined;
    if (payload.type === "run.started") {
      ordinal =
        payload.run.agentId === view.thread.rootAgentId
          ? (payload.run.ordinal ?? (ordinal ?? 0) + 1)
          : (this.agents.get(payload.run.agentId) ?? ordinal);
      if (ordinal === undefined) return;
      this.runs.set(payload.run.id, ordinal);
      this.agentRuns.set(payload.run.agentId, payload.run.id);
      this.agents.set(payload.run.agentId, ordinal);
      if (payload.run.agentId === view.thread.rootAgentId) this.current.set(threadId, ordinal);
      const turn = this.ensure(event, ordinal);
      turn.agents.add(payload.run.agentId);
      turn.summary.startedAt = Math.min(turn.summary.startedAt, payload.run.startedAt);
    } else if (payload.type === "item.created" || payload.type === "item.updated") {
      const item = payload.item;
      ordinal =
        this.items.get(item.id) ??
        (item.runId ? this.runs.get(item.runId) : undefined) ??
        (item.agentId ? this.agents.get(item.agentId) : undefined) ??
        ordinal;
      if (item.type === "message" && item.role === "user" && payload.type === "item.created") {
        const current = ordinal === undefined ? undefined : this.turns.get(threadId)?.get(ordinal);
        if (!current || current.summary.outcome !== "active")
          ordinal = (this.current.get(threadId) ?? 0) + 1;
      }
      if (ordinal === undefined) return;
      this.items.set(item.id, ordinal);
      if (!this.itemSeqs.has(item.id)) this.itemSeqs.set(item.id, event.seq);
      const turn = this.ensure(event, ordinal);
      previousContribution = turn.contributions.get(item.id);
      nextContribution = itemDigestContribution(item);
      if (
        Object.keys(nextContribution.counters).length ||
        nextContribution.files.length ||
        nextContribution.commands.length
      )
        turn.contributions.set(item.id, nextContribution);
      else turn.contributions.delete(item.id);
      this.replaceItem(turn, item.id, turn.contributions.get(item.id), item.agentId, event.seq);
      if (item.type === "message")
        this.replaceMessage(
          turn,
          threadId,
          item.id,
          item.role,
          itemMessagePreview(item),
          event.seq,
        );
    } else if (payload.type === "agent.created" && payload.agent.parentId !== null) {
      ordinal = this.agents.get(payload.agent.parentId) ?? ordinal;
      if (ordinal === undefined) return;
      this.agents.set(payload.agent.id, ordinal);
      const turn = this.ensure(event, ordinal);
      turn.agents.add(payload.agent.id);
      turn.counters.subagentsStarted = (turn.counters.subagentsStarted ?? 0) + 1;
    } else if (payload.type === "agent.status") {
      ordinal = this.agents.get(payload.agentId) ?? ordinal;
      if (ordinal !== undefined) {
        const counters = this.ensure(event, ordinal).counters;
        if (payload.status.state === "failed" && this.agentStates.get(payload.agentId) !== "failed")
          counters.errors = (counters.errors ?? 0) + 1;
      }
      this.agentStates.set(payload.agentId, payload.status.state);
    } else if (payload.type === "run.ended") {
      ordinal = this.runs.get(payload.runId) ?? ordinal;
      if (ordinal === undefined) return;
      const run = view.runs[payload.runId];
      const turn = this.ensure(event, ordinal);
      if (run?.agentId === view.thread.rootAgentId) {
        turn.summary.outcome = payload.state;
        turn.summary.endedAt = payload.endedAt;
      }
    } else if (payload.type === "interaction.opened") {
      ordinal = this.agents.get(payload.interaction.agentId) ?? ordinal;
      if (ordinal === undefined) return;
      this.interactions.set(payload.interaction.id, ordinal);
      if (payload.interaction.request.kind === "approval") {
        const counters = this.ensure(event, ordinal).counters;
        counters.approvalsAsked = (counters.approvalsAsked ?? 0) + 1;
        counters.approvalsPending = (counters.approvalsPending ?? 0) + 1;
        this.pending.set(threadId, (this.pending.get(threadId) ?? 0) + 1);
        const reviewed = approvalAutoReviewed(payload.interaction);
        counters.approvalsAutoReviewed = (counters.approvalsAutoReviewed ?? 0) + Number(reviewed);
        this.autoReviewed.set(payload.interaction.id, reviewed);
      }
    } else if (payload.type === "interaction.closed") {
      ordinal = this.interactions.get(payload.interactionId) ?? ordinal;
      if (ordinal === undefined) return;
      const interaction = view.interactions[payload.interactionId];
      if (interaction?.request.kind === "approval") {
        const counters = this.ensure(event, ordinal).counters;
        counters.approvalsPending = Math.max(0, (counters.approvalsPending ?? 0) - 1);
        this.pending.set(threadId, Math.max(0, (this.pending.get(threadId) ?? 0) - 1));
        if (payload.state === "resolved")
          counters.approvalsAnswered = (counters.approvalsAnswered ?? 0) + 1;
        const reviewed = approvalAutoReviewed(interaction);
        counters.approvalsAutoReviewed =
          (counters.approvalsAutoReviewed ?? 0) +
          Number(reviewed) -
          Number(this.autoReviewed.get(payload.interactionId) ?? false);
        this.autoReviewed.set(payload.interactionId, reviewed);
      }
    } else if (payload.type === "permission.reviewed") {
      ordinal = this.interactions.get(payload.review.interactionId);
      if (ordinal === undefined) return;
      const interaction = view.interactions[payload.review.interactionId];
      if (interaction?.request.kind === "approval") {
        const counters = this.ensure(event, ordinal).counters;
        const reviewed = approvalAutoReviewed(interaction);
        counters.approvalsAutoReviewed =
          (counters.approvalsAutoReviewed ?? 0) +
          Number(reviewed) -
          Number(this.autoReviewed.get(payload.review.interactionId) ?? false);
        this.autoReviewed.set(payload.review.interactionId, reviewed);
      }
    } else if (payload.type === "usage.updated") {
      if (!countsTowardTurnUsage(payload)) return;
      ordinal = this.agents.get(payload.agentId) ?? ordinal;
      if (ordinal === undefined) return;
      const counters = this.ensure(event, ordinal).counters;
      const policy = counterPolicy(
        payload,
        view.thread.provider,
        this.agentRuns.get(payload.agentId) ?? "unknown",
      );
      const scope = JSON.stringify([threadId, payload.agentId, payload.model ?? "", policy.scope]);
      const sample = accountSample(
        payload,
        view.thread.provider,
        policy.mode,
        this.usage.get(scope),
      );
      if (policy.tracked) this.usage.set(scope, sample.next);
      this.usageKnown.add(threadId);
      counters.tokenSamples = (counters.tokenSamples ?? 0) + 1;
      counters.inputTokens = (counters.inputTokens ?? 0) + sample.delta.input;
      counters.outputTokens = (counters.outputTokens ?? 0) + sample.delta.output;
    } else if (payload.type === "item.delta") {
      ordinal = this.items.get(payload.itemId) ?? ordinal;
      const item = view.items[payload.itemId];
      if (ordinal !== undefined && item?.type === "message")
        this.replaceMessage(
          this.ensure(event, ordinal),
          threadId,
          item.id,
          item.role,
          itemMessagePreview(item),
          event.seq,
        );
    } else if (payload.type === "item.deleted") {
      ordinal = this.items.get(payload.itemId) ?? ordinal;
      if (ordinal !== undefined) {
        const owner = this.ensure(event, ordinal);
        previousContribution = owner.contributions.get(payload.itemId);
        owner.contributions.delete(payload.itemId);
        this.replaceItem(owner, payload.itemId, undefined, undefined, event.seq);
        this.replaceMessage(owner, threadId, payload.itemId, undefined, "", event.seq);
      }
    }
    if (ordinal === undefined) return;
    const turn = this.ensure(event, ordinal);
    turn.summary.endSeq = Math.max(turn.summary.endSeq, event.seq);
    this.refresh(turn, view);
    const difference: Record<string, number> = {};
    for (const key of new Set([
      ...Object.keys(turn.reportedCounters),
      ...Object.keys(turn.counters),
    ]))
      difference[key] = (turn.counters[key] ?? 0) - (turn.reportedCounters[key] ?? 0);
    turn.reportedCounters = { ...turn.counters };
    const changed = combineAggregates(
      contributionAggregate(previousContribution, event.seq, -1),
      contributionAggregate(nextContribution, event.seq),
      { ...emptyAggregate(), counters: difference },
    );
    if (
      Object.values(changed.counters).some((value) => value !== 0) ||
      changed.files.length ||
      changed.commands.length
    ) {
      const changes = this.changes.get(threadId) ?? new ChangeIndex();
      changes.append(event.seq, event.at, changed);
      this.changes.set(threadId, changes);
    }
    if (ordinal === this.current.get(threadId))
      turn.summary.status = turnActivityStatus({}, [turn.summary.status, view.thread.status]) ?? {
        ...view.thread.status,
      };
    this.recordCompletion(threadId, turn, event);
  }

  private refresh(turn: TurnRecord, view: ThreadView): void {
    const children = [...turn.agents].flatMap((id) => {
      const agent = view.agents[id];
      return agent && agent.parentId !== null ? [agent] : [];
    });
    turn.counters.subagentsFinished = children.filter((agent) =>
      ["idle", "interrupted", "failed"].includes(agent.status.state),
    ).length;
    turn.summary.digest = aggregateDigest(
      combineAggregates(turn.itemAggregate.all(), { ...emptyAggregate(), counters: turn.counters }),
    );
    const liveChildren = children.filter(
      (agent) => !["idle", "interrupted", "failed"].includes(agent.status.state),
    );
    const liveTools = (turn.itemAggregate.all().counters["live:tools"] ?? 0) > 0;
    turn.summary.status = turnActivityStatus(
      {
        "live:interactions": turn.summary.digest.approvalsPending,
        "live:runs": Number(turn.summary.outcome === "active"),
        "live:tools": Number(liveTools),
        "live:agents": liveChildren.length,
      },
      children.map((agent) => agentThreadStatus(agent.status)),
    ) ?? { state: turn.summary.outcome === "failed" ? "failed" : "done" };
    turn.summary.subagents = children.slice(0, 32).map((agent) => {
      const summary: TurnSubagentSummary = {
        agentId: agent.id,
        status: agentThreadStatus(agent.status),
        startedAt: agent.createdAt,
        digest: aggregateDigest(turn.agentAggregates.get(agent.id)?.all() ?? emptyAggregate()),
      };
      if (agent.childThreadId) summary.threadId = agent.childThreadId;
      if (agent.name) summary.name = agent.name.slice(0, 1024);
      if (agent.endedAt !== undefined) summary.endedAt = agent.endedAt;
      return summary;
    });
    turn.summary.subagentsTruncated = children.length > 32;
  }

  summaries(threadId: string): TurnSummary[] {
    return [...(this.turns.get(threadId)?.values() ?? [])]
      .map((turn) => turn.summary)
      .toSorted((left, right) => left.ordinal - right.ordinal);
  }
  currentStatus(threadId: string): TurnSummary["status"] | undefined {
    const ordinal = this.current.get(threadId);
    return ordinal === undefined
      ? undefined
      : this.turns.get(threadId)?.get(ordinal)?.summary.status;
  }
  itemTurn(itemId: string): number | null {
    return this.items.get(itemId) ?? null;
  }
  private replaceMessage(
    turn: TurnRecord,
    threadId: string,
    itemId: string,
    role: string | undefined,
    preview: string,
    eventSeq: number,
  ): void {
    const seq = this.itemSeqs.get(itemId) ?? eventSeq;
    const value = emptyAggregate();
    if (role === "user") value.firstUser = { seq, preview };
    if (role === "assistant") value.latestAssistant = { seq, preview };
    turn.messages.set(seq, 0, value);
    const thread = this.threadMessages.get(threadId) ?? new AggregateIndex();
    thread.set(seq, 0, value);
    this.threadMessages.set(threadId, thread);
    turn.summary.initiatingMessagePreview = turn.messages.all().firstUser?.preview ?? "";
    turn.summary.latestAgentMessagePreview = turn.messages.all().latestAssistant?.preview ?? "";
  }
  private replaceItem(
    turn: TurnRecord,
    itemId: string,
    contribution: DigestContribution | undefined,
    agentId: string | undefined,
    seq: number,
  ): void {
    const key = this.itemSeqs.get(itemId) ?? seq;
    const aggregate = contributionAggregate(contribution, seq);
    if (contribution || this.itemAgents.has(itemId)) turn.itemAggregate.set(key, 0, aggregate);
    const previousAgent = this.itemAgents.get(itemId);
    if (previousAgent && previousAgent !== agentId)
      turn.agentAggregates.get(previousAgent)?.set(key, 0, emptyAggregate());
    if (agentId && contribution) {
      this.itemAgents.set(itemId, agentId);
      const agent = turn.agentAggregates.get(agentId) ?? new AggregateIndex();
      agent.set(key, 0, aggregate);
      turn.agentAggregates.set(agentId, agent);
    }
  }

  private recordCompletion(threadId: string, turn: TurnRecord, event: DeliveryEvent): void {
    const done = turn.summary.outcome !== "active" && turnIsSettled(turn.summary.status);
    if (done === Boolean(turn.settled)) return;
    const sequence = this.completedSeq.get(threadId) ?? new AggregateIndex();
    const time = this.completedTime.get(threadId) ?? new AggregateIndex();
    if (turn.settled) {
      sequence.set(turn.settled.seq, turn.summary.ordinal, emptyAggregate());
      time.set(turn.settled.at, turn.summary.ordinal, emptyAggregate());
      delete turn.settled;
    } else {
      turn.settled = { seq: event.seq, at: event.at };
      const value = { ...emptyAggregate(), counters: { turnsCompleted: 1 } };
      sequence.set(event.seq, turn.summary.ordinal, value);
      time.set(event.at, turn.summary.ordinal, value);
    }
    this.completedSeq.set(threadId, sequence);
    this.completedTime.set(threadId, time);
  }

  completed(
    threadId: string,
    since: { sinceSeq?: number | undefined; sinceTime?: number | undefined },
  ): number {
    return (
      (since.sinceSeq !== undefined
        ? this.completedSeq.get(threadId)?.after(since.sinceSeq)
        : this.completedTime.get(threadId)?.after(since.sinceTime ?? 0)
      )?.counters.turnsCompleted ?? 0
    );
  }
  latestMessage(threadId: string): { seq: number; preview: string } | undefined {
    return this.threadMessages.get(threadId)?.all().latestAssistant;
  }
  rangeDigest(
    threadId: string,
    since: { sinceSeq?: number | undefined; sinceTime?: number | undefined },
  ): TurnDigest {
    const result = aggregateDigest(this.changes.get(threadId)?.range(since) ?? emptyAggregate());
    if (this.usageKnown.has(threadId)) {
      result.inputTokens ??= 0;
      result.outputTokens ??= 0;
    }
    result.approvalsPending = this.pending.get(threadId) ?? 0;
    return result;
  }
  private pending = new Map<string, number>();
}
