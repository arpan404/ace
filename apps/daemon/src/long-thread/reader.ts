import { z } from "zod";
import {
  AgentId,
  ThreadStatus,
  AgentStatus,
  TurnSummary,
  TurnsPageResponse,
  ThreadCatchUpResponse,
  ThreadReadStateResponse,
  type Thread,
  type TurnsPageRequest,
  type ThreadCatchUpRequest,
  type TurnSubagentSummary,
} from "@ace/protocol";
import {
  agentThreadStatus,
  mergeTurnDigests,
  turnIsSettled,
  turnActivityStatus,
} from "@ace/projection";
import { LongThreadDatabase } from "./database.ts";
import { Digests } from "./digests.ts";

const TurnRow = z.object({
  ordinal: z.number(),
  start_seq: z.number(),
  end_seq: z.number(),
  started_at: z.number(),
  ended_at: z.number().nullable(),
  root_outcome: z.enum(["active", "completed", "interrupted", "failed"]),
  settled_seq: z.number().nullable(),
  initiating: z.string(),
  latest: z.string(),
});
export class TurnReader {
  private readonly data: LongThreadDatabase;
  private readonly digests: Digests;
  private readonly thread: (id: string) => Thread | undefined;
  constructor(data: LongThreadDatabase, thread: (id: string) => Thread | undefined) {
    this.data = data;
    this.digests = new Digests(data);
    this.thread = thread;
  }
  private status(
    thread: string,
    ordinal: number,
    row: z.infer<typeof TurnRow>,
  ): import("@ace/protocol").ThreadStatus {
    const head = this.data
      .sql("SELECT ordinal,status FROM long_heads WHERE thread_id=?")
      .get(thread);
    if (Number(head?.ordinal) === ordinal) {
      const status =
        this.thread(thread)?.status ?? ThreadStatus.parse(JSON.parse(String(head?.status)));
      if (!turnIsSettled(status) || status.state === "failed") return status;
    }
    const linked = this.data
      .sql(
        "SELECT t.status FROM long_agents a JOIN threads t ON t.id=a.child_thread WHERE a.thread_id=? AND a.ordinal=? AND json_extract(t.status,'$.state') NOT IN ('done','new','failed') AND json_extract(t.client,'$.deletedAt') IS NULL ORDER BY CASE json_extract(t.status,'$.state') WHEN 'needs_you' THEN 0 WHEN 'working' THEN 1 WHEN 'limited' THEN 2 WHEN 'waiting' THEN CASE json_extract(t.status,'$.on') WHEN 'network' THEN 3 WHEN 'upstream' THEN 4 WHEN 'background_task' THEN 5 ELSE 7 END ELSE 6 END LIMIT 1",
      )
      .get(thread, ordinal);
    const owned = this.data
      .sql(
        "SELECT status FROM long_agents WHERE thread_id=? AND ordinal=? AND json_extract(status,'$.state') NOT IN ('idle','interrupted','failed') ORDER BY CASE json_extract(status,'$.state') WHEN 'blocked' THEN CASE json_extract(status,'$.on') WHEN 'human' THEN 0 WHEN 'subagents' THEN 1 WHEN 'rate_limit' THEN 2 WHEN 'network' THEN 3 WHEN 'upstream' THEN 4 ELSE 5 END WHEN 'unresponsive' THEN 6 ELSE 1 END LIMIT 1",
      )
      .get(thread, ordinal);
    const counters = this.digests.counts(thread, ordinal);
    const active = turnActivityStatus(counters, [
      ...(linked ? [ThreadStatus.parse(JSON.parse(String(linked.status)))] : []),
      ...(owned ? [agentThreadStatus(AgentStatus.parse(JSON.parse(String(owned.status))))] : []),
    ]);
    if (active) return active;
    if (row.settled_seq === null) return { state: "working", agents: 1 };
    return { state: row.root_outcome === "failed" ? "failed" : "done" };
  }
  summary(thread: string, value: unknown): import("@ace/protocol").TurnSummary {
    const row = TurnRow.parse(value);
    const root = this.data.sql("SELECT root FROM long_heads WHERE thread_id=?").get(thread)?.root;
    const agents = this.data
      .sql(
        "SELECT * FROM long_agents WHERE thread_id=? AND ordinal=? AND id<>? ORDER BY id LIMIT 33",
      )
      .all(thread, row.ordinal, String(root ?? ""));
    const subagents = agents.slice(0, 32).map((agent) => {
      const child = agent.child_thread == null ? undefined : String(agent.child_thread);
      const childThread = child ? this.thread(child) : undefined;
      const summary: TurnSubagentSummary = {
        agentId: AgentId.parse(agent.id),
        status:
          childThread?.status ??
          agentThreadStatus(AgentStatus.parse(JSON.parse(String(agent.status)))),
        startedAt: Number(agent.started_at),
        digest: childThread
          ? this.digests.read(childThread.id, 0)
          : this.digests.readAgent(thread, row.ordinal, String(agent.id)),
      };
      if (childThread) summary.threadId = childThread.id;
      if (agent.name != null) summary.name = String(agent.name);
      if (agent.ended_at != null) summary.endedAt = Number(agent.ended_at);
      return summary;
    });
    return TurnSummary.parse({
      threadId: thread,
      ordinal: row.ordinal,
      startSeq: row.start_seq,
      endSeq: row.end_seq,
      startedAt: row.started_at,
      ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
      status: this.status(thread, row.ordinal, row),
      outcome: row.root_outcome,
      initiatingMessagePreview: row.initiating,
      latestAgentMessagePreview: row.latest,
      digest: this.digests.read(thread, row.ordinal),
      subagents,
      subagentsTruncated: agents.length > 32,
    });
  }
  page(input: TurnsPageRequest, seq: number): import("@ace/protocol").TurnsPageResponse {
    const rows =
      input.after === undefined
        ? this.data
            .sql(
              "SELECT * FROM long_turns WHERE thread_id=? AND ordinal<? ORDER BY ordinal DESC LIMIT ?",
            )
            .all(input.threadId, input.before ?? Number.MAX_SAFE_INTEGER, input.limit)
        : this.data
            .sql(
              "SELECT * FROM long_turns WHERE thread_id=? AND ordinal>? ORDER BY ordinal LIMIT ?",
            )
            .all(input.threadId, input.after, input.limit);
    const turns: import("@ace/protocol").TurnSummary[] = [];
    let bytes = 1024;
    for (const row of rows) {
      const turn = this.summary(input.threadId, row);
      let size = Buffer.byteLength(JSON.stringify(turn));
      if (size > 1024 * 1024 - 1024) {
        for (const child of turn.subagents) {
          child.digest.truncated ||=
            child.digest.files.length > 0 || child.digest.commands.length > 0;
          child.digest.files = [];
          child.digest.commands = [];
        }
        size = Buffer.byteLength(JSON.stringify(turn));
        if (size > 1024 * 1024 - 1024) {
          turn.digest.truncated ||= turn.digest.files.length > 0 || turn.digest.commands.length > 0;
          turn.digest.files = [];
          turn.digest.commands = [];
          size = Buffer.byteLength(JSON.stringify(turn));
        }
      }
      if (bytes + size > 1024 * 1024 && turns.length) break;
      turns.push(turn);
      bytes += size;
    }
    if (input.after === undefined) turns.reverse();
    const first = turns[0]?.ordinal,
      last = turns.at(-1)?.ordinal;
    const before =
      first !== undefined &&
      this.data
        .sql("SELECT 1 FROM long_turns WHERE thread_id=? AND ordinal<? LIMIT 1")
        .get(input.threadId, first)
        ? Number(first)
        : null;
    const after =
      last !== undefined &&
      this.data
        .sql("SELECT 1 FROM long_turns WHERE thread_id=? AND ordinal>? LIMIT 1")
        .get(input.threadId, last)
        ? Number(last)
        : null;
    return TurnsPageResponse.parse({
      type: "turns.page",
      requestId: input.requestId,
      threadId: input.threadId,
      seq,
      indexedSeq: this.data.digestIndexedSeq(),
      ready: this.data.digestIndexedSeq() >= seq,
      turns,
      before,
      after,
    });
  }
  catchUp(
    input: ThreadCatchUpRequest,
    seq: number,
    family: readonly string[],
  ): import("@ace/protocol").ThreadCatchUpResponse {
    const thread = this.thread(input.threadId);
    if (!thread) throw new Error("thread_not_found");
    let latest = "",
      latestSeq = -1;
    for (const id of family) {
      const message = this.data
        .sql(
          "SELECT preview,created_seq FROM long_items WHERE thread_id=? AND role='assistant' ORDER BY created_seq DESC LIMIT 1",
        )
        .get(id);
      if (message && Number(message.created_seq) > latestSeq) {
        latest = String(message.preview);
        latestSeq = Number(message.created_seq);
      }
    }
    const digests = this.digests;
    function* summaries(): Generator<import("@ace/protocol").TurnDigest> {
      for (const id of family) {
        yield input.sinceSeq === undefined
          ? digests.readSinceTime(id, input.sinceTime ?? 0)
          : digests.read(id, 0, input.sinceSeq);
      }
    }
    const digest = mergeTurnDigests(summaries());
    return ThreadCatchUpResponse.parse({
      type: "thread.catchUp",
      requestId: input.requestId,
      threadId: input.threadId,
      seq,
      indexedSeq: this.data.digestIndexedSeq(),
      ready: this.data.digestIndexedSeq() >= seq,
      turnsCompleted: this.digests.ranges.completedAfter(
        input.threadId,
        input.sinceSeq === undefined
          ? { sinceTime: input.sinceTime ?? 0 }
          : { sinceSeq: input.sinceSeq },
      ),
      status: thread.status,
      digest,
      latestAgentMessagePreview: String(latest),
    });
  }
  ordinal(thread: string, item: string): number | null {
    const row = this.data
      .sql("SELECT ordinal FROM long_items WHERE thread_id=? AND item_id=?")
      .get(thread, item);
    return row ? Number(row.ordinal) : null;
  }
  readState(
    thread: string,
    device: string,
    requestId = "read-state",
  ): import("@ace/protocol").ThreadReadStateResponse {
    const row = this.data
      .sql("SELECT last_seen_seq,updated_at FROM long_read_state WHERE thread_id=? AND device_id=?")
      .get(thread, device);
    return ThreadReadStateResponse.parse({
      type: "thread.readState",
      requestId,
      threadId: thread,
      lastSeenSeq: Number(row?.last_seen_seq ?? 0),
      updatedAt: row ? Number(row.updated_at) : null,
    });
  }
  markRead(thread: string, device: string, lastSeenSeq: number, head: number, at: number): void {
    const value = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(lastSeenSeq);
    this.data.run(
      `INSERT INTO long_read_state VALUES(?,?,?,?) ON CONFLICT(thread_id,device_id) DO UPDATE SET last_seen_seq=excluded.last_seen_seq,updated_at=excluded.updated_at WHERE excluded.last_seen_seq>long_read_state.last_seen_seq`,
      thread,
      device,
      Math.min(value, head),
      at,
    );
  }
  descendantThreads(thread: string): string[] {
    const rows = this.data
      .sql(
        `WITH RECURSIVE tree(id) AS (SELECT ? UNION SELECT a.child_thread FROM long_agents a JOIN tree ON a.thread_id=tree.id JOIN threads t ON t.id=a.child_thread WHERE a.child_thread IS NOT NULL AND json_extract(t.client,'$.deletedAt') IS NULL) SELECT id FROM tree LIMIT 513`,
      )
      .all(thread);
    if (rows.length > 512) throw new Error("thread_tree_too_large");
    return rows.map((row) => String(row.id));
  }
}
