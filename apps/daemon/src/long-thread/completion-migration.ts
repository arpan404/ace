import { completionRelevanceReader, deriveThreadStatus } from "@ace/core";
import { ThreadId, type Thread, type Event, type EventPayload } from "@ace/protocol";
import { decodeSnapshot } from "../engine/snapshot.ts";
import { Snapshot } from "../engine/persistence.ts";
import { engineSchemaVersion } from "../engine/schema-version.ts";
import { LongThreadDatabase } from "./database.ts";
import { CanonicalCompletionEvidence } from "./canonical-completion-evidence.ts";

interface Source {
  getThread(id: ThreadId): Thread | undefined;
  appendEvents(id: ThreadId, events: EventPayload[], at: number): unknown;
  readEvents(input: {
    threadId?: ThreadId;
    afterSeq: number;
    limit: number;
    byteLimit?: number;
  }): Event[];
}

interface Replay {
  id: ThreadId;
  afterSeq: number;
  evidence: CanonicalCompletionEvidence;
}

/** Correct already-indexed diagnostics through canonical appends so all counter,
 * range, settlement and client projections use their existing mutation owners.
 * The cursor and appends commit together; restart never applies a correction twice.
 */
export class CompletionMigration {
  private readonly data: LongThreadDatabase;
  private replay: Replay | undefined;
  constructor(data: LongThreadDatabase) {
    this.data = data;
  }
  done(): boolean {
    return this.data.sql("SELECT done FROM long_completion_migration WHERE id=1").get()?.done === 1;
  }
  batch(source: Source): void {
    if (this.replay) {
      this.replayBatch(source);
      return;
    }
    const cursor = String(
      this.data.sql("SELECT thread FROM long_completion_migration WHERE id=1").get()?.thread,
    );
    const snapshots = Boolean(
      this.data.sql("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_state'").get(),
    );
    const rows = this.data
      .sql(`SELECT DISTINCT thread_id FROM long_agents
      WHERE thread_id>? AND completion_relevant=1 AND json_extract(status,'$.state')='unresponsive'
      ORDER BY thread_id LIMIT 16`)
      .all(cursor);
    for (const row of rows) {
      const id = ThreadId.parse(row.thread_id);
      const thread = source.getThread(id);
      if (thread && thread.deletedAt === undefined) {
        const header = snapshots
          ? this.data
              .sql(
                "SELECT state FROM thread_state WHERE thread_id=? AND json_extract(state,'$.engineSnapshot')=?",
              )
              .get(id, engineSchemaVersion)
          : undefined;
        if (!header) {
          this.replay = { id, afterSeq: 0, evidence: new CanonicalCompletionEvidence() };
          this.replayBatch(source);
          return;
        }
        const state = new Snapshot(this.data.db, decodeSnapshot(String(header.state))).state;
        const relevant = completionRelevanceReader(state);
        const events: EventPayload[] = [];
        for (const [key, record] of Object.entries(state.agents)) {
          if (record.agent.status.state !== "unresponsive" || relevant(key)) continue;
          const indexed = this.data
            .sql("SELECT completion_relevant FROM long_agents WHERE thread_id=? AND id=?")
            .get(id, record.agent.id);
          if (indexed?.completion_relevant === 1)
            events.push({
              type: "agent.status",
              agentId: record.agent.id,
              status: record.agent.status,
              completionRelevant: false,
            });
        }
        if (events.length) {
          // Keep independent current work and human waits. An old unresponsive
          // thread can become done only when its complete persisted tree proves it.
          const status = deriveThreadStatus(state);
          events.push({
            type: "thread.updated",
            status:
              thread.status.state === "unresponsive" && status.state === "done"
                ? status
                : thread.status,
          });
          source.appendEvents(id, events, this.latest(id).at);
        }
      }
      this.data.run("UPDATE long_completion_migration SET thread=? WHERE id=1", id);
    }
    if (rows.length < 16) this.finish();
  }
  private latest(id: ThreadId): { seq: number; at: number } {
    const row = this.data
      .sql("SELECT seq,at FROM events WHERE thread_id=? ORDER BY seq DESC LIMIT 1")
      .get(id);
    return { seq: Number(row?.seq ?? 0), at: Number(row?.at ?? 0) };
  }
  private replayBatch(source: Source): void {
    const replay = this.replay;
    if (!replay) return;
    for (const event of source.readEvents({
      threadId: replay.id,
      afterSeq: replay.afterSeq,
      limit: 128,
      byteLimit: 512 * 1024,
    })) {
      replay.evidence.record(event);
      replay.afterSeq = event.seq;
    }
    const latest = this.latest(replay.id);
    if (replay.afterSeq < latest.seq) return;
    const thread = source.getThread(replay.id);
    // Whole-tree completion is affirmative evidence that legacy canonical data
    // did not hide a disconnect, retry or external wait. Without a snapshot,
    // preserve ambiguity while the thread still reports unfinished work.
    if (thread && thread.deletedAt === undefined && thread.status.state === "done") {
      const events = replay.evidence
        .corrections()
        .filter(
          (event) =>
            event.type === "agent.status" &&
            this.data
              .sql("SELECT completion_relevant FROM long_agents WHERE thread_id=? AND id=?")
              .get(replay.id, event.agentId)?.completion_relevant === 1,
        );
      if (events.length) {
        events.push({ type: "thread.updated", status: thread.status });
        source.appendEvents(replay.id, events, latest.at);
      }
    }
    // Only finished replays advance the durable cursor. An interrupted replay
    // restarts at its beginning, before any correction has been committed.
    this.data.run("UPDATE long_completion_migration SET thread=? WHERE id=1", replay.id);
    this.replay = undefined;
  }
  private finish(): void {
    this.data.run("UPDATE long_completion_migration SET done=1 WHERE id=1");
  }
}
