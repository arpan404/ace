import { completionRelevanceReader, deriveThreadStatus } from "@ace/core";
import { ThreadId, type Thread, type EventPayload } from "@ace/protocol";
import { decodeSnapshot } from "../engine/snapshot.ts";
import { Snapshot } from "../engine/persistence.ts";
import { engineSchemaVersion } from "../engine/schema-version.ts";
import { LongThreadDatabase } from "./database.ts";

interface Source {
  getThread(id: ThreadId): Thread | undefined;
  appendEvents(id: ThreadId, events: EventPayload[], at: number): unknown;
}

/** Correct already-indexed diagnostics through canonical appends so all counter,
 * range, settlement and client projections use their existing mutation owners.
 * The cursor and appends commit together; restart never applies a correction twice.
 */
export class CompletionMigration {
  private readonly data: LongThreadDatabase;
  constructor(data: LongThreadDatabase) {
    this.data = data;
  }
  done(): boolean {
    return this.data.sql("SELECT done FROM long_completion_migration WHERE id=1").get()?.done === 1;
  }
  batch(source: Source): void {
    if (
      !this.data.sql("SELECT 1 FROM sqlite_master WHERE type='table' AND name='thread_state'").get()
    ) {
      this.finish();
      return;
    }
    const cursor = String(
      this.data.sql("SELECT thread FROM long_completion_migration WHERE id=1").get()?.thread,
    );
    const rows = this.data
      .sql(`SELECT s.thread_id,s.state FROM thread_state s
      WHERE s.thread_id>? AND json_extract(s.state,'$.engineSnapshot')=?
      AND EXISTS(SELECT 1 FROM long_agents a WHERE a.thread_id=s.thread_id
        AND a.completion_relevant=1 AND json_extract(a.status,'$.state')='unresponsive')
      ORDER BY s.thread_id LIMIT 16`)
      .all(cursor, engineSchemaVersion);
    for (const row of rows) {
      const id = ThreadId.parse(row.thread_id);
      const thread = source.getThread(id);
      if (thread && thread.deletedAt === undefined) {
        const state = new Snapshot(this.data.db, decodeSnapshot(String(row.state))).state;
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
          const at = Number(
            this.data
              .sql("SELECT at FROM events WHERE thread_id=? ORDER BY seq DESC LIMIT 1")
              .get(id)?.at,
          );
          source.appendEvents(id, events, at);
        }
      }
      this.data.run("UPDATE long_completion_migration SET thread=? WHERE id=1", id);
    }
    if (rows.length < 16) this.finish();
  }
  private finish(): void {
    this.data.run("UPDATE long_completion_migration SET done=1 WHERE id=1");
  }
}
