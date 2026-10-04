import { accountSample, counterPolicy } from "@ace/usage/accounting";
import {
  agentThreadStatus,
  approvalAutoReviewed,
  turnActivityStatus,
  digestContributions,
  digestFromCounters,
  emptyTurnDigest,
  itemDigestContribution,
  itemMessagePreview,
  mergeTurnDigests,
  type DigestContribution,
} from "@ace/projection";
import type {
  DeliveryEvent,
  ThreadView,
  TurnSummary,
  TurnDigest,
  TurnSubagentSummary,
} from "@ace/protocol";

interface TurnRecord {
  summary: TurnSummary;
  contributions: Map<string, DigestContribution>;
  counters: Record<string, number>;
  agents: Set<string>;
}

/** Fake-mode derived data. Reads use these summaries rather than replaying the transcript. */
export class FakeTurnIndex {
  private changes = new Map<
    string,
    Array<{
      seq: number;
      at: number;
      counters: Record<string, number>;
      files: TurnDigest["files"];
      commands: TurnDigest["commands"];
    }>
  >();
  private itemAgents = new Map<string, string>();
  private turns = new Map<string, Map<number, TurnRecord>>();
  private runs = new Map<string, number>();
  private agents = new Map<string, number>();
  private items = new Map<string, number>();
  private interactions = new Map<string, number>();
  private autoReviewed = new Map<string, boolean>();
  private current = new Map<string, number>();
  private usage = new Map<string, ReturnType<typeof accountSample>["next"]>();
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
    let previousCounters: Record<string, number> = {};
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
      if (item.agentId) this.itemAgents.set(item.id, item.agentId);
      if (item.type === "message") {
        if (item.role === "user" && !turn.summary.initiatingMessagePreview)
          turn.summary.initiatingMessagePreview = itemMessagePreview(item);
        if (item.role === "assistant")
          turn.summary.latestAgentMessagePreview = itemMessagePreview(item);
      }
    } else if (payload.type === "agent.created" && payload.agent.parentId !== null) {
      ordinal = this.agents.get(payload.agent.parentId) ?? ordinal;
      if (ordinal === undefined) return;
      this.agents.set(payload.agent.id, ordinal);
      const turn = this.ensure(event, ordinal);
      turn.agents.add(payload.agent.id);
      previousCounters = { ...turn.counters };
      turn.counters.subagentsStarted = (turn.counters.subagentsStarted ?? 0) + 1;
    } else if (payload.type === "agent.status") {
      ordinal = this.agents.get(payload.agentId) ?? ordinal;
      if (ordinal !== undefined) {
        const counters = this.ensure(event, ordinal).counters;
        previousCounters = { ...counters };
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
        previousCounters = { ...counters };
        counters.approvalsAsked = (counters.approvalsAsked ?? 0) + 1;
        counters.approvalsPending = (counters.approvalsPending ?? 0) + 1;
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
        previousCounters = { ...counters };
        counters.approvalsPending = Math.max(0, (counters.approvalsPending ?? 0) - 1);
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
        previousCounters = { ...counters };
        const reviewed = approvalAutoReviewed(interaction);
        counters.approvalsAutoReviewed =
          (counters.approvalsAutoReviewed ?? 0) +
          Number(reviewed) -
          Number(this.autoReviewed.get(payload.review.interactionId) ?? false);
        this.autoReviewed.set(payload.review.interactionId, reviewed);
      }
    } else if (payload.type === "usage.updated") {
      ordinal = this.agents.get(payload.agentId) ?? ordinal;
      if (ordinal === undefined) return;
      const counters = this.ensure(event, ordinal).counters;
      previousCounters = { ...counters };
      const policy = counterPolicy(
        payload,
        view.thread.provider,
        this.agentRuns.get(payload.agentId) ?? "unknown",
      );
      const scope = JSON.stringify([
        threadId,
        payload.usageScope === "provider_session" || payload.usageScope === "model_session"
          ? null
          : payload.agentId,
        policy.scope,
      ]);
      const sample = accountSample(
        payload,
        view.thread.provider,
        policy.mode,
        this.usage.get(scope),
      );
      if (policy.tracked) this.usage.set(scope, sample.next);
      counters.inputTokens = (counters.inputTokens ?? 0) + sample.delta.input;
      counters.outputTokens = (counters.outputTokens ?? 0) + sample.delta.output;
    } else if (payload.type === "item.delta") {
      ordinal = this.items.get(payload.itemId) ?? ordinal;
      const item = view.items[payload.itemId];
      if (ordinal !== undefined && item?.type === "message" && item.role === "assistant")
        this.ensure(event, ordinal).summary.latestAgentMessagePreview = itemMessagePreview(item);
    } else if (payload.type === "item.deleted") {
      ordinal = this.items.get(payload.itemId) ?? ordinal;
      if (ordinal !== undefined) {
        const owner = this.ensure(event, ordinal);
        previousContribution = owner.contributions.get(payload.itemId);
        owner.contributions.delete(payload.itemId);
      }
    }
    if (ordinal === undefined) return;
    const turn = this.ensure(event, ordinal);
    turn.summary.endSeq = Math.max(turn.summary.endSeq, event.seq);
    this.refresh(turn, view);
    const difference: Record<string, number> = {};
    for (const key of new Set([
      ...Object.keys(previousContribution?.counters ?? {}),
      ...Object.keys(nextContribution?.counters ?? {}),
    ]))
      difference[key] =
        (nextContribution?.counters[key] ?? 0) - (previousContribution?.counters[key] ?? 0);
    if (
      [
        "interaction.opened",
        "interaction.closed",
        "permission.reviewed",
        "usage.updated",
        "agent.created",
        "agent.status",
      ].includes(payload.type)
    )
      for (const [key, value] of Object.entries(turn.counters))
        difference[key] = (difference[key] ?? 0) + value - (previousCounters[key] ?? 0);
    const files =
      nextContribution?.files.length && !previousContribution?.files.length
        ? nextContribution.files
        : [];
    const commands = nextContribution?.commands ?? [];
    if (Object.values(difference).some((value) => value !== 0) || files.length || commands.length) {
      const changes = this.changes.get(threadId) ?? [];
      changes.push({ seq: event.seq, at: event.at, counters: difference, files, commands });
      this.changes.set(threadId, changes);
    }
    if (ordinal === this.current.get(threadId)) turn.summary.status = { ...view.thread.status };
  }

  private refresh(turn: TurnRecord, view: ThreadView): void {
    const children = [...turn.agents].flatMap((id) => {
      const agent = view.agents[id];
      return agent && agent.parentId !== null ? [agent] : [];
    });
    turn.counters.subagentsFinished = children.filter((agent) =>
      ["idle", "interrupted", "failed"].includes(agent.status.state),
    ).length;
    turn.summary.digest = mergeTurnDigests([
      digestContributions(turn.contributions.values()),
      digestFromCounters(turn.counters),
    ]);
    const liveChildren = children.filter(
      (agent) => !["idle", "interrupted", "failed"].includes(agent.status.state),
    );
    const liveTools = [...turn.contributions.values()].some(
      (contribution) => (contribution.counters["live:tools"] ?? 0) > 0,
    );
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
        digest: digestContributions(
          [...turn.contributions]
            .filter(([id]) => this.itemAgents.get(id) === agent.id)
            .map(([, contribution]) => contribution),
        ),
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
  itemTurn(itemId: string): number | null {
    return this.items.get(itemId) ?? null;
  }
  rangeDigest(
    threadId: string,
    since: { sinceSeq?: number | undefined; sinceTime?: number | undefined },
  ): TurnDigest {
    const counters: Record<string, number> = {};
    const changes = this.changes.get(threadId) ?? [];
    const changed = (change: { seq: number; at: number }) =>
      since.sinceSeq !== undefined
        ? change.seq > since.sinceSeq
        : change.at > (since.sinceTime ?? 0);
    for (const change of changes) {
      if (!changed(change)) continue;
      for (const [key, value] of Object.entries(change.counters))
        counters[key] = (counters[key] ?? 0) + value;
    }
    function* digests(): Generator<TurnDigest> {
      yield digestFromCounters(counters);
      for (const change of changes)
        if (changed(change) && (change.files.length || change.commands.length))
          yield { ...emptyTurnDigest(), files: change.files, commands: change.commands };
    }
    return mergeTurnDigests(digests());
  }
}
