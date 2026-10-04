import { ThreadId as importThreadIdSchema } from "@ace/protocol";
import { z } from "zod";
import { AgentStatus, Interaction, ThreadStatus, type Event, type Thread } from "@ace/protocol";
import { itemMessagePreview, itemDigestContribution, approvalAutoReviewed } from "@ace/projection";
import { counterPolicy, accountSample, Counts, countsTowardTurnUsage } from "@ace/usage";
import { LongThreadDatabase, decodeCounters } from "./database.ts";
import { Digests } from "./digests.ts";
import {
  itemTurnOrdinal,
  createdAgentTurnOrdinal,
  startedRunTurnOrdinal,
  agentActivityCounters,
  agentActivityTransition,
  turnSettlementTransition,
} from "./decisions.ts";

const Head = z.object({ ordinal: z.number(), root: z.string().nullable(), status: z.string() });
const ApprovalData = Interaction.pick({
  state: true,
  autoReviewed: true,
  review: true,
  request: true,
  agentId: true,
});
const TaskData = z.object({ ambient: z.boolean(), status: z.string(), agentId: z.string() });

/** All mutations share the canonical append transaction. No mutable index cache survives rollback. */
export class TurnWriter {
  readonly data: LongThreadDatabase;
  readonly digests: Digests;
  private readonly affected = new Set<number>();
  constructor(data: LongThreadDatabase) {
    this.data = data;
    this.digests = new Digests(data);
  }
  private head(thread: string) {
    const row = this.data
      .sql("SELECT ordinal,root,status FROM long_heads WHERE thread_id=?")
      .get(thread);
    return row ? Head.parse(row) : undefined;
  }
  private ensure(event: Event, ordinal: number): number {
    this.affected.add(ordinal);
    this.data.run(
      "INSERT OR IGNORE INTO long_turns(thread_id,ordinal,start_seq,end_seq,started_at) VALUES(?,?,?,?,?)",
      event.threadId,
      ordinal,
      event.seq,
      event.seq,
      event.at,
    );
    this.data.run(
      "UPDATE long_turns SET end_seq=MAX(end_seq,?) WHERE thread_id=? AND ordinal=?",
      event.seq,
      event.threadId,
      ordinal,
    );
    return ordinal;
  }
  private current(event: Event): number {
    return this.ensure(event, Math.max(1, this.head(event.threadId)?.ordinal ?? 1));
  }
  private agentOrdinal(event: Event, id: string): number {
    const row = this.data
      .sql("SELECT ordinal FROM long_agents WHERE thread_id=? AND id=?")
      .get(event.threadId, id);
    return row && Number(row.ordinal) > 0 ? Number(row.ordinal) : this.current(event);
  }
  private itemOrdinal(event: Event, id: string): number | undefined {
    const row = this.data
      .sql("SELECT ordinal FROM long_items WHERE thread_id=? AND item_id=?")
      .get(event.threadId, id);
    return row ? Number(row.ordinal) : undefined;
  }
  record(event: Event, thread: Thread): void {
    if (this.data.indexedSeq() >= event.seq) return;
    this.affected.clear();
    const p = event.payload;
    if (p.type === "thread.created") {
      this.data.run(
        "INSERT OR IGNORE INTO long_heads VALUES(?,0,?,?)",
        event.threadId,
        p.thread.rootAgentId ?? null,
        JSON.stringify(p.thread.status),
      );
    } else if (!this.head(event.threadId)) {
      this.data.run(
        "INSERT OR IGNORE INTO long_heads VALUES(?,0,?,?)",
        event.threadId,
        thread.rootAgentId ?? null,
        JSON.stringify(thread.status),
      );
    }
    if (p.type === "agent.created") {
      if (p.agent.origin === "root")
        this.data.run("UPDATE long_heads SET root=? WHERE thread_id=?", p.agent.id, event.threadId);
      const headOrdinal = this.head(event.threadId)?.ordinal ?? 0;
      const spawnedByOrdinal =
        p.agent.origin !== "root" && p.agent.spawnedBy
          ? this.itemOrdinal(event, p.agent.spawnedBy)
          : undefined;
      const existingAgent = this.data
        .sql("SELECT ordinal FROM long_agents WHERE thread_id=? AND id=?")
        .get(event.threadId, p.agent.id);
      const ordinal = createdAgentTurnOrdinal({
        existingOrdinal: existingAgent
          ? z.number().int().nonnegative().parse(Number(existingAgent.ordinal))
          : undefined,
        origin: p.agent.origin,
        headOrdinal,
        spawnedByOrdinal,
        parentOrdinal:
          p.agent.origin !== "root" && spawnedByOrdinal === undefined && p.agent.parentId
            ? this.agentOrdinal(event, p.agent.parentId)
            : undefined,
        currentOrdinal: Math.max(1, headOrdinal),
      });
      this.agent(
        event,
        p.agent.id,
        ordinal,
        p.agent.status,
        p.agent.childThreadId,
        p.agent.name,
        p.agent.createdAt,
        p.agent.endedAt,
      );
    } else if (p.type === "agent.status" || p.type === "agent.updated") {
      const old = this.data
        .sql("SELECT * FROM long_agents WHERE thread_id=? AND id=?")
        .get(event.threadId, p.agentId);
      if (old)
        this.agent(
          event,
          p.agentId,
          Number(old.ordinal),
          p.type === "agent.status" ? p.status : AgentStatus.parse(JSON.parse(String(old.status))),
          p.type === "agent.updated"
            ? (p.childThreadId ?? (old.child_thread == null ? undefined : String(old.child_thread)))
            : old.child_thread == null
              ? undefined
              : String(old.child_thread),
          p.type === "agent.updated"
            ? (p.name ?? (old.name == null ? undefined : String(old.name)))
            : old.name == null
              ? undefined
              : String(old.name),
          Number(old.started_at),
          p.type === "agent.updated"
            ? (p.endedAt ?? (old.ended_at == null ? undefined : Number(old.ended_at)))
            : old.ended_at == null
              ? undefined
              : Number(old.ended_at),
        );
    } else if (p.type === "run.started") {
      const root = p.run.agentId === this.head(event.threadId)?.root;
      const known = this.data
        .sql("SELECT ordinal FROM client_run_index WHERE thread_id=? AND run_id=?")
        .get(event.threadId, p.run.id);
      const ordinal = this.ensure(
        event,
        startedRunTurnOrdinal({
          root,
          providerOrdinal: p.run.ordinal,
          knownOrdinal: known ? Number(known.ordinal) : undefined,
          headOrdinal: this.head(event.threadId)?.ordinal ?? 0,
          agentOrdinal: root ? 0 : this.agentOrdinal(event, p.run.agentId),
        }),
      );
      const old = this.data
        .sql("SELECT live FROM long_runs WHERE thread_id=? AND id=?")
        .get(event.threadId, p.run.id);
      this.data.run(
        `INSERT INTO long_runs VALUES(?,?,?,?,1) ON CONFLICT(thread_id,id) DO UPDATE SET live=1`,
        event.threadId,
        p.run.id,
        ordinal,
        Number(root),
      );
      this.digests.bump(event, ordinal, "live:runs", 1 - Number(old?.live ?? 0));
      if (root) {
        this.data.run("UPDATE long_heads SET ordinal=? WHERE thread_id=?", ordinal, event.threadId);
        this.data.run(
          "UPDATE long_turns SET root_run=?,root_outcome='active' WHERE thread_id=? AND ordinal=?",
          p.run.id,
          event.threadId,
          ordinal,
        );
        const agent = this.data
          .sql("SELECT * FROM long_agents WHERE thread_id=? AND id=?")
          .get(event.threadId, p.run.agentId);
        if (agent)
          this.agent(
            event,
            p.run.agentId,
            ordinal,
            AgentStatus.parse(JSON.parse(String(agent.status))),
            undefined,
            undefined,
            Number(agent.started_at),
          );
      }
    } else if (p.type === "run.ended") {
      const row = this.data
        .sql("SELECT ordinal,root,live FROM long_runs WHERE thread_id=? AND id=?")
        .get(event.threadId, p.runId);
      if (row) {
        const ordinal = this.ensure(event, Number(row.ordinal));
        this.data.run(
          "UPDATE long_runs SET live=0 WHERE thread_id=? AND id=?",
          event.threadId,
          p.runId,
        );
        this.digests.bump(event, ordinal, "live:runs", -Number(row.live));
        if (row.root)
          this.data.run(
            "UPDATE long_turns SET root_outcome=? WHERE thread_id=? AND ordinal=?",
            p.state,
            event.threadId,
            ordinal,
          );
      }
    } else if (p.type === "item.created" || p.type === "item.updated") this.item(event, p.item);
    else if (p.type === "item.delta") {
      const ordinal = this.itemOrdinal(event, p.itemId);
      if (ordinal !== undefined) this.ensure(event, ordinal);
      if (ordinal !== undefined && p.field === "text") {
        const row = this.data
          .sql("SELECT role,preview FROM long_items WHERE thread_id=? AND item_id=?")
          .get(event.threadId, p.itemId);
        if (row?.role) {
          const preview = (
            String(row.preview) + p.append.slice(0, Math.max(0, 1024 - String(row.preview).length))
          ).slice(0, 1024);
          this.data.run(
            "UPDATE long_items SET preview=? WHERE thread_id=? AND item_id=?",
            preview,
            event.threadId,
            p.itemId,
          );
          this.preview(event, ordinal, String(row.role), preview, p.itemId);
        }
      }
    } else if (p.type === "item.deleted") {
      const old = this.data
        .sql("SELECT ordinal,counters,agent_id FROM long_items WHERE thread_id=? AND item_id=?")
        .get(event.threadId, p.itemId);
      if (old) {
        this.ensure(event, Number(old.ordinal));
        this.digests.replace(event, Number(old.ordinal), decodeCounters(old.counters), {});
        this.digests.itemDetails(
          event,
          Number(old.ordinal),
          p.itemId,
          { counters: {}, files: [], commands: [] },
          undefined,
        );
        if (old.agent_id != null)
          this.digests.agentReplace(
            event,
            Number(old.ordinal),
            String(old.agent_id),
            decodeCounters(old.counters),
            {},
          );
        this.data.run(
          "DELETE FROM long_items WHERE thread_id=? AND item_id=?",
          event.threadId,
          p.itemId,
        );
        this.repairPreviews(event.threadId, Number(old.ordinal));
      }
    } else if (p.type === "interaction.opened") {
      const interaction = p.interaction;
      const ordinal = interaction.toolCallId
        ? (this.itemOrdinal(event, interaction.toolCallId) ??
          this.agentOrdinal(event, interaction.agentId))
        : this.agentOrdinal(event, interaction.agentId);
      this.approval(event, interaction.id, ordinal, ApprovalData.parse(interaction));
    } else if (p.type === "interaction.closed") {
      const row = this.data
        .sql(
          "SELECT ordinal,data FROM long_entities WHERE thread_id=? AND kind='approval' AND id=?",
        )
        .get(event.threadId, p.interactionId);
      if (row)
        this.approval(event, p.interactionId, Number(row.ordinal), {
          ...ApprovalData.parse(JSON.parse(String(row.data))),
          state: p.state,
          ...(p.autoReviewed === undefined ? {} : { autoReviewed: p.autoReviewed }),
        });
    } else if (p.type === "permission.reviewed") {
      const row = this.data
        .sql(
          "SELECT ordinal,data FROM long_entities WHERE thread_id=? AND kind='approval' AND id=?",
        )
        .get(event.threadId, p.review.interactionId);
      if (row)
        this.approval(event, p.review.interactionId, Number(row.ordinal), {
          ...ApprovalData.parse(JSON.parse(String(row.data))),
          review: p.review,
        });
    } else if (p.type === "background_task.started") {
      const task = p.task;
      const ordinal = task.toolCallId
        ? (this.itemOrdinal(event, task.toolCallId) ?? this.agentOrdinal(event, task.agentId))
        : this.agentOrdinal(event, task.agentId);
      this.task(event, task.id, ordinal, TaskData.parse(task));
    } else if (p.type === "background_task.updated") {
      const row = this.data
        .sql("SELECT ordinal,data FROM long_entities WHERE thread_id=? AND kind='task' AND id=?")
        .get(event.threadId, p.taskId);
      if (row)
        this.task(event, p.taskId, Number(row.ordinal), {
          ...TaskData.parse(JSON.parse(String(row.data))),
          status: p.status,
        });
    } else if (p.type === "usage.updated") {
      // Inclusive session snapshots are separate from agent counters, never summed twice.
      if (countsTowardTurnUsage(p)) {
        const ordinal = this.agentOrdinal(event, p.agentId);
        const run = this.data
          .sql("SELECT id FROM long_runs WHERE thread_id=? AND ordinal=? AND root=1 LIMIT 1")
          .get(event.threadId, ordinal);
        const policy = counterPolicy(p, thread.provider, String(run?.id ?? ordinal));
        const id = JSON.stringify([
          p.agentId,
          p.model ?? "",
          policy.scope,
          policy.tracked ? "" : event.seq,
        ]);
        const old = policy.tracked
          ? this.data
              .sql("SELECT value FROM long_usage_counters WHERE thread_id=? AND id=?")
              .get(event.threadId, id)
          : undefined;
        const sample = accountSample(
          p,
          thread.provider,
          policy.mode,
          old ? Counts.parse(JSON.parse(String(old.value))) : undefined,
        );
        this.digests.bump(event, ordinal, "inputTokens", sample.delta.input);
        this.digests.bump(event, ordinal, "outputTokens", sample.delta.output);
        this.digests.bump(event, ordinal, "tokenSamples", 1);
        this.digests.agentReplace(
          event,
          ordinal,
          p.agentId,
          {},
          { inputTokens: sample.delta.input, outputTokens: sample.delta.output, tokenSamples: 1 },
        );
        if (policy.tracked)
          this.data.run(
            "INSERT INTO long_usage_counters VALUES(?,?,?) ON CONFLICT(thread_id,id) DO UPDATE SET value=excluded.value",
            event.threadId,
            id,
            JSON.stringify(sample.next),
          );
      }
    } else if (p.type === "thread.updated" && p.status)
      this.data.run(
        "UPDATE long_heads SET status=? WHERE thread_id=?",
        JSON.stringify(p.status),
        event.threadId,
      );
    // Status changes may finish an earlier background turn as well as the current root turn.
    if (p.type !== "item.delta") this.settle(event);
    if (p.type === "thread.updated" && p.status) this.refreshParents(event);
    this.data.run("UPDATE long_meta SET seq=? WHERE id=1", event.seq);
  }
  repairPreviews(thread: string, ordinal: number): void {
    this.data.run(
      `UPDATE long_turns SET
        initiating=COALESCE((SELECT preview FROM long_items WHERE thread_id=? AND ordinal=? AND role='user' ORDER BY created_seq LIMIT 1),''),
        latest=COALESCE((SELECT preview FROM long_items WHERE thread_id=? AND ordinal=? AND role='assistant' ORDER BY created_seq DESC LIMIT 1),'')
        WHERE thread_id=? AND ordinal=?`,
      thread,
      ordinal,
      thread,
      ordinal,
      thread,
      ordinal,
    );
  }
  private preview(
    event: Event,
    ordinal: number,
    role: string,
    preview: string,
    itemId: string,
  ): void {
    if (role === "user")
      this.data.run(
        "UPDATE long_turns SET initiating=? WHERE thread_id=? AND ordinal=? AND (SELECT item_id FROM long_items WHERE thread_id=? AND ordinal=? AND role='user' ORDER BY created_seq LIMIT 1)=?",
        preview,
        event.threadId,
        ordinal,
        event.threadId,
        ordinal,
        itemId,
      );
    else
      this.data.run(
        "UPDATE long_turns SET latest=? WHERE thread_id=? AND ordinal=? AND (SELECT item_id FROM long_items WHERE thread_id=? AND ordinal=? AND role='assistant' ORDER BY created_seq DESC LIMIT 1)=?",
        preview,
        event.threadId,
        ordinal,
        event.threadId,
        ordinal,
        itemId,
      );
  }
  private item(event: Event, item: import("@ace/protocol").Item): void {
    const old = this.data
      .sql("SELECT ordinal,counters,agent_id FROM long_items WHERE thread_id=? AND item_id=?")
      .get(event.threadId, item.id);
    const run = item.runId
      ? this.data
          .sql("SELECT ordinal FROM long_runs WHERE thread_id=? AND id=?")
          .get(event.threadId, item.runId)
      : undefined;
    const head = this.head(event.threadId);
    const rootUserMessage =
      item.type === "message" && item.role === "user" && item.agentId === head?.root;
    const active =
      rootUserMessage && !old && !run
        ? this.data
            .sql("SELECT root_run,initiating FROM long_turns WHERE thread_id=? AND ordinal=?")
            .get(event.threadId, head?.ordinal ?? 0)
        : undefined;
    const ordinal = itemTurnOrdinal({
      existingOrdinal: old ? Number(old.ordinal) : undefined,
      runOrdinal: run ? Number(run.ordinal) : undefined,
      fallbackOrdinal:
        !old && !run && item.agentId
          ? this.agentOrdinal(event, item.agentId)
          : Math.max(1, head?.ordinal ?? 1),
      rootUserMessage,
      headOrdinal: head?.ordinal ?? 0,
      currentTurn: active
        ? {
            hasRootRun: Boolean(active.root_run),
            hasInitiatingPreview: Boolean(active.initiating),
          }
        : undefined,
    });
    this.ensure(event, ordinal);
    const contribution = itemDigestContribution(item);
    this.digests.replace(
      event,
      ordinal,
      old ? decodeCounters(old.counters) : {},
      contribution.counters,
    );
    if (old?.agent_id != null)
      this.digests.agentReplace(
        event,
        ordinal,
        String(old.agent_id),
        decodeCounters(old.counters),
        {},
      );
    if (item.agentId)
      this.digests.agentReplace(event, ordinal, item.agentId, {}, contribution.counters);
    if (item.type === "tool_call" || (old && Object.keys(decodeCounters(old.counters)).length))
      this.digests.itemDetails(event, ordinal, item.id, contribution, item.agentId);
    const preview = itemMessagePreview(item);
    this.data.run(
      `INSERT INTO long_items VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(thread_id,item_id) DO UPDATE SET preview=excluded.preview,counters=excluded.counters,agent_id=excluded.agent_id`,
      event.threadId,
      item.id,
      ordinal,
      event.seq,
      item.type === "message" ? item.role : null,
      preview,
      JSON.stringify(contribution.counters),
      item.agentId ?? null,
    );
    if (item.type === "message") this.preview(event, ordinal, item.role, preview, item.id);
  }
  private approval(
    event: Event,
    id: string,
    ordinal: number,
    approval: z.infer<typeof ApprovalData>,
  ): void {
    const isApproval = approval.request.kind === "approval";
    const pending = approval.state === "pending";
    this.digests.entity(
      event,
      "approval",
      id,
      ordinal,
      {
        approvalsAsked: Number(isApproval),
        approvalsAnswered: Number(isApproval && approval.state === "resolved"),
        approvalsAutoReviewed: Number(isApproval && approvalAutoReviewed(approval)),
        approvalsPending: Number(isApproval && pending),
        "live:interactions": Number(pending),
      },
      approval,
    );
    this.ensure(event, ordinal);
  }
  private task(event: Event, id: string, ordinal: number, task: z.infer<typeof TaskData>): void {
    this.digests.entity(
      event,
      "task",
      id,
      ordinal,
      { "live:tasks": Number(task.status === "running" && !task.ambient) },
      task,
    );
    this.ensure(event, ordinal);
  }
  private agent(
    event: Event,
    id: string,
    ordinal: number,
    status: import("@ace/protocol").AgentStatus,
    child: string | undefined,
    name: string | undefined,
    start: number,
    end?: number,
  ): void {
    const old = this.data
      .sql("SELECT ordinal,status FROM long_agents WHERE thread_id=? AND id=?")
      .get(event.threadId, id);
    const isRoot = id === this.head(event.threadId)?.root;
    const childHead = child ? this.head(child) : undefined;
    const linkedChildStatus = childHead
      ? ThreadStatus.parse(JSON.parse(childHead.status))
      : undefined;
    const previousStatus = old ? AgentStatus.parse(JSON.parse(String(old.status))) : undefined;
    const previousCounters = previousStatus
      ? agentActivityCounters({
          root: isRoot,
          status: previousStatus,
          linkedChildStatus,
        })
      : {};
    const nextCounters = agentActivityCounters({ root: isRoot, status, linkedChildStatus });
    const snapshot = this.data
      .sql("SELECT counters FROM long_entities WHERE thread_id=? AND kind='agentActivity' AND id=?")
      .get(event.threadId, id);
    const activity = agentActivityTransition({
      root: isRoot,
      ordinal,
      previousOrdinal: old ? Number(old.ordinal) : undefined,
      turnSettled:
        isRoot && old && Number(old.ordinal) === ordinal
          ? this.data
              .sql("SELECT settled_seq FROM long_turns WHERE thread_id=? AND ordinal=?")
              .get(event.threadId, ordinal)?.settled_seq != null
          : false,
      status,
      previousStatus,
    });
    if (activity.recordActivity) {
      if (activity.recordError) this.digests.bump(event, ordinal, "errors", 1);
      if (old && Number(old.ordinal) > 0) this.affected.add(Number(old.ordinal));
      this.digests.move(
        event,
        old ? Number(old.ordinal) : ordinal,
        ordinal,
        snapshot
          ? decodeCounters(snapshot.counters)
          : old && Number(old.ordinal) > 0
            ? previousCounters
            : {},
        nextCounters,
      );
    }
    this.data.run(
      "INSERT INTO long_entities VALUES(?,'agentActivity',?,?,?,?,?) ON CONFLICT(thread_id,kind,id) DO UPDATE SET ordinal=excluded.ordinal,counters=excluded.counters,data=excluded.data,last_seq=excluded.last_seq",
      event.threadId,
      id,
      ordinal,
      JSON.stringify(
        activity.recordActivity ? nextCounters : snapshot ? decodeCounters(snapshot.counters) : {},
      ),
      "{}",
      event.seq,
    );
    this.data.run(
      `INSERT INTO long_agents VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(thread_id,id) DO UPDATE SET ordinal=excluded.ordinal,status=excluded.status,child_thread=COALESCE(excluded.child_thread,child_thread),name=COALESCE(excluded.name,name),ended_at=COALESCE(excluded.ended_at,ended_at),last_seq=excluded.last_seq`,
      event.threadId,
      id,
      ordinal,
      JSON.stringify(status),
      child ?? null,
      name?.slice(0, 1024) ?? null,
      start,
      end ?? null,
      event.seq,
    );
    if (activity.recordActivity) this.ensure(event, ordinal);
  }
  private refreshParents(event: Event): void {
    const queue = [event.threadId];
    const visited = new Set<string>();
    while (queue.length) {
      const child = queue.shift();
      if (!child || visited.has(child)) continue;
      visited.add(child);
      if (visited.size > 512) throw new Error("thread_tree_too_large");
      for (const parent of this.data
        .sql("SELECT * FROM long_agents WHERE child_thread=?")
        .all(child)) {
        const threadId = importThreadIdSchema.parse(parent.thread_id);
        this.affected.clear();
        this.affected.add(Number(parent.ordinal));
        const parentEvent = { ...event, threadId };
        this.agent(
          parentEvent,
          String(parent.id),
          Number(parent.ordinal),
          AgentStatus.parse(JSON.parse(String(parent.status))),
          child,
          parent.name == null ? undefined : String(parent.name),
          Number(parent.started_at),
          parent.ended_at == null ? undefined : Number(parent.ended_at),
        );
        this.settle(parentEvent);
        queue.push(threadId);
      }
    }
  }
  private settle(event: Event): void {
    const head = this.head(event.threadId);
    if (!head) return;
    this.affected.add(head.ordinal);
    for (const ordinal of this.affected) {
      const row = this.data
        .sql("SELECT root_outcome,settled_seq FROM long_turns WHERE thread_id=? AND ordinal=?")
        .get(event.threadId, ordinal);
      if (!row) continue;
      const counts = this.digests.counts(event.threadId, ordinal);
      const linkedLive = Boolean(
        this.data
          .sql(
            "SELECT 1 FROM long_agents a JOIN long_heads h ON h.thread_id=a.child_thread JOIN threads t ON t.id=a.child_thread WHERE a.thread_id=? AND a.ordinal=? AND json_extract(h.status,'$.state') NOT IN ('done','new','failed') AND json_extract(t.client,'$.deletedAt') IS NULL LIMIT 1",
          )
          .get(event.threadId, ordinal),
      );
      const transition = turnSettlementTransition({
        rootOutcome: String(row.root_outcome),
        alreadySettled: row.settled_seq != null,
        ordinal,
        currentOrdinal: head.ordinal,
        currentStatus: ThreadStatus.parse(JSON.parse(head.status)),
        linkedChildLive: linkedLive,
        counters: counts,
      });
      if (transition === "settle") {
        this.data.run(
          "UPDATE long_turns SET settled_seq=?,ended_at=?,end_seq=MAX(end_seq,?) WHERE thread_id=? AND ordinal=?",
          event.seq,
          event.at,
          event.seq,
          event.threadId,
          ordinal,
        );
        this.digests.bump(event, ordinal, "turnsCompleted", 1);
      } else if (transition === "reopen") {
        this.data.run(
          "UPDATE long_turns SET settled_seq=NULL,ended_at=NULL WHERE thread_id=? AND ordinal=?",
          event.threadId,
          ordinal,
        );
        this.digests.bump(event, ordinal, "turnsCompleted", -1);
      }
    }
  }
}
