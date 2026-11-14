import { z } from "zod";
import {
  AgentId,
  AgentStatus,
  ThreadCatchUpResponse,
  ThreadReadStateResponse,
  ThreadStatus,
  TurnSubagentSummary,
  TurnSummary,
  TurnsPageResponse,
  type Thread,
  type ThreadId,
  type TurnDigest,
  type TurnsPageRequest,
  type ThreadCatchUpRequest,
} from "@ace/protocol";
import {
  agentThreadStatus,
  mergeTurnDigests,
  turnIsSettled,
  turnActivityStatus,
} from "@ace/projection";
import { LongThreadDatabase, type Counters } from "./database.ts";
import { Digests } from "./digests.ts";
import { readAgentDigests, readTurnDigests, type AgentKey, type TurnKey } from "./turn-digests.ts";

// Each field the page shows is decoded with the protocol field it becomes.
const TurnRow = z.object({
  ordinal: TurnSummary.shape.ordinal,
  start_seq: TurnSummary.shape.startSeq,
  end_seq: TurnSummary.shape.endSeq,
  started_at: TurnSummary.shape.startedAt,
  ended_at: TurnSummary.shape.startedAt.nullable(),
  root_outcome: TurnSummary.shape.outcome,
  settled_seq: z.number().nullable(),
  initiating: TurnSummary.shape.initiatingMessagePreview,
  latest: TurnSummary.shape.latestAgentMessagePreview,
});
// The index has no build fingerprint: whichever build indexed a turn wrote its JSON, so every
// protocol value taken from it is validated here. Only the page built from them is not.
const indexStatus = (json: unknown): ThreadStatus => ThreadStatus.parse(JSON.parse(String(json)));
const indexAgentStatus = (json: unknown): AgentStatus =>
  AgentStatus.parse(JSON.parse(String(json)));
const SubagentName = TurnSubagentSummary.shape.name;
const SubagentTime = TurnSubagentSummary.shape.startedAt;
const IndexedSeq = TurnsPageResponse.shape.indexedSeq;
export class TurnReader {
  private readonly data: LongThreadDatabase;
  private readonly digests: Digests;
  private readonly thread: (id: string) => Thread | undefined;
  constructor(data: LongThreadDatabase, thread: (id: string) => Thread | undefined) {
    this.data = data;
    this.digests = new Digests(data);
    this.thread = thread;
  }
  /** The turn's status, read with the page's one `long_heads` row and the turn's counters. */
  private status(
    thread: string,
    row: z.infer<typeof TurnRow>,
    head: Record<string, unknown> | undefined,
    counters: Counters,
  ): ThreadStatus {
    if (Number(head?.ordinal) === row.ordinal) {
      const status = this.thread(thread)?.status ?? indexStatus(head?.status);
      if (!turnIsSettled(status) || status.state === "failed") return status;
    }
    const linked = this.data
      .sql(
        "SELECT t.status FROM long_agents a JOIN threads t ON t.id=a.child_thread WHERE a.thread_id=? AND a.ordinal=? AND json_extract(t.status,'$.state')='working' AND json_extract(t.client,'$.deletedAt') IS NULL ORDER BY CASE json_extract(t.status,'$.state') WHEN 'needs_you' THEN 0 WHEN 'working' THEN 1 WHEN 'limited' THEN 2 WHEN 'waiting' THEN CASE json_extract(t.status,'$.on') WHEN 'network' THEN 3 WHEN 'upstream' THEN 4 WHEN 'background_task' THEN 5 ELSE 7 END ELSE 6 END LIMIT 1",
      )
      .get(thread, row.ordinal);
    const owned = this.data
      .sql(
        "SELECT status FROM long_agents WHERE thread_id=? AND ordinal=? AND completion_relevant=1 AND json_extract(status,'$.state') NOT IN ('idle','interrupted','failed') ORDER BY CASE json_extract(status,'$.state') WHEN 'blocked' THEN CASE json_extract(status,'$.on') WHEN 'human' THEN 0 WHEN 'subagents' THEN 1 WHEN 'rate_limit' THEN 2 WHEN 'network' THEN 3 WHEN 'upstream' THEN 4 ELSE 5 END WHEN 'unresponsive' THEN 6 ELSE 1 END LIMIT 1",
      )
      .get(thread, row.ordinal);
    const active = turnActivityStatus(counters, [
      ...(linked ? [indexStatus(linked.status)] : []),
      ...(owned ? [agentThreadStatus(indexAgentStatus(owned.status))] : []),
    ]);
    // Built from the turn's counters, which are index rows: their counts are checked here.
    if (active) return ThreadStatus.parse(active);
    if (row.settled_seq === null) return { state: "working", agents: 1 };
    return { state: row.root_outcome === "failed" ? "failed" : "done" };
  }
  /**
   * The summaries of a page's turns, in the order of `rows`. Their agents and every digest are
   * read for the whole page at once, one statement per table (`turn-digests.ts`).
   */
  private summaries(thread: ThreadId, rows: readonly z.infer<typeof TurnRow>[]): TurnSummary[] {
    if (!rows.length) return [];
    const head = this.data
      .sql("SELECT ordinal,root,status FROM long_heads WHERE thread_id=?")
      .get(thread);
    const root = head?.root == null ? undefined : String(head.root);
    const agents = Array.from({ length: rows.length }, (): Record<string, unknown>[] => []);
    for (const agent of this.data
      .sql(
        "SELECT j.key AS k, a.* FROM json_each(?) j CROSS JOIN long_agents a WHERE a.rowid IN (SELECT rowid FROM long_agents WHERE thread_id=? AND ordinal=j.value AND id<>? ORDER BY id LIMIT 33) ORDER BY j.key, a.id",
      )
      .iterate(JSON.stringify(rows.map((row) => row.ordinal)), thread, root ?? ""))
      agents[Number(agent.k)]?.push(agent);
    // Every digest the page shows: each turn's, then each child thread's; each agent's share.
    const turnKeys: TurnKey[] = rows.map((row) => [thread, row.ordinal]);
    const agentKeys: AgentKey[] = [];
    const shown = rows.map((row, index) => {
      const main = root === undefined ? undefined : agentKeys.push([row.ordinal, root]) - 1;
      const subagents = (agents[index] ?? []).slice(0, 32).map((agent) => {
        const child =
          agent.child_thread == null ? undefined : this.thread(String(agent.child_thread));
        const digest = child
          ? { turn: turnKeys.push([child.id, 0]) - 1 }
          : { agent: agentKeys.push([row.ordinal, String(agent.id)]) - 1 };
        return { agent, child, digest };
      });
      return { main, subagents };
    });
    const turnDigests = readTurnDigests(this.data, turnKeys);
    const agentDigests = readAgentDigests(this.data, thread, agentKeys);
    const digestAt = (at: { turn: number } | { agent: number }): TurnDigest => {
      const digest = "turn" in at ? turnDigests[at.turn]?.digest : agentDigests[at.agent];
      if (!digest) throw new Error("Missing turn digest");
      return digest;
    };
    return rows.map((row, index) => {
      const own = turnDigests[index];
      const page = shown[index];
      if (!own || !page) throw new Error("Missing turn digest");
      const subagents = page.subagents.map(({ agent, child, digest }) => {
        // In the schema's field order, as a parse of it would give.
        const summary: TurnSubagentSummary = {
          agentId: AgentId.parse(agent.id),
          ...(child ? { threadId: child.id } : {}),
          ...(agent.name == null ? {} : { name: SubagentName.parse(agent.name) }),
          status: child?.status ?? agentThreadStatus(indexAgentStatus(agent.status)),
          startedAt: SubagentTime.parse(agent.started_at),
          ...(agent.ended_at == null ? {} : { endedAt: SubagentTime.parse(agent.ended_at) }),
          digest: digestAt(digest),
        };
        return summary;
      });
      return {
        threadId: thread,
        ordinal: row.ordinal,
        startSeq: row.start_seq,
        endSeq: row.end_seq,
        startedAt: row.started_at,
        ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
        status: this.status(thread, row, head, own.counters),
        outcome: row.root_outcome,
        initiatingMessagePreview: row.initiating,
        latestAgentMessagePreview: row.latest,
        digest: own.digest,
        ...(root === undefined || page.main === undefined
          ? {}
          : {
              main: { agentId: AgentId.parse(root), digest: digestAt({ agent: page.main }) },
            }),
        subagents,
        subagentsTruncated: (agents[index]?.length ?? 0) > 32,
      };
    });
  }
  /** Built from index values validated as they are read, so the page is not validated again. */
  page(input: TurnsPageRequest, seq: number): TurnsPageResponse {
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
    const turns: TurnSummary[] = [];
    let bytes = 1024;
    for (const turn of this.summaries(
      input.threadId,
      rows.map((row) => TurnRow.parse(row)),
    )) {
      let size = Buffer.byteLength(JSON.stringify(turn));
      if (size > 1024 * 1024 - 1024) {
        for (const child of turn.main ? [...turn.subagents, turn.main] : turn.subagents) {
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
    const indexedSeq = IndexedSeq.parse(this.data.digestIndexedSeq());
    return {
      type: "turns.page",
      requestId: input.requestId,
      threadId: input.threadId,
      seq,
      indexedSeq,
      ready: indexedSeq >= seq,
      turns,
      before,
      after,
    };
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
