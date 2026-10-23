import { z } from "zod";
import type { InteractionRequest, ThreadId } from "@ace/protocol";
import type { ThreadState } from "@ace/core";
import type { Store } from "../store.ts";

/** What a restart capture saw when it recorded the continuation. */
export interface RestartCapture {
  /** The request the agent was waiting on the person to answer, if any. */
  waitingOn: string | undefined;
}

/**
 * The evidence behind a restart continuation, saved with it. Stopping the provider expires its
 * open requests, so a later reader (startup after a graceful shutdown, or after a crash between
 * startup's passes) can no longer see that the agent was waiting on the person. Startup takes
 * this record when it decides whether to continue the thread.
 */
export class RestartCaptures {
  private store: Store;
  constructor(store: Store) {
    this.store = store;
    store.atomic((db) =>
      db.exec(`CREATE TABLE IF NOT EXISTS engine_restart_captures (
        thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
        waiting_on TEXT
      )`),
    );
  }
  record(id: ThreadId, capture: RestartCapture): void {
    this.store
      .statement(
        "INSERT INTO engine_restart_captures(thread_id,waiting_on) VALUES (?,?) ON CONFLICT(thread_id) DO UPDATE SET waiting_on=excluded.waiting_on",
      )
      .run(id, capture.waitingOn ?? null);
  }
  has(id: ThreadId): boolean {
    return Boolean(
      this.store.statement("SELECT 1 FROM engine_restart_captures WHERE thread_id=?").get(id),
    );
  }
  /** Reads and removes the record: each capture informs one startup decision. */
  take(id: ThreadId): RestartCapture | undefined {
    const row = this.store
      .statement("SELECT waiting_on FROM engine_restart_captures WHERE thread_id=?")
      .get(id);
    if (!row) return undefined;
    this.clear(id);
    const waitingOn = z
      .string()
      .nullable()
      .parse(row.waiting_on ?? null);
    return { waitingOn: waitingOn ?? undefined };
  }
  clear(id: ThreadId): void {
    this.store.statement("DELETE FROM engine_restart_captures WHERE thread_id=?").run(id);
  }
}

/** One line naming what the agent's open request asks the person, if it has one. */
export function openRequestLine(state: ThreadState): string | undefined {
  for (const key of Object.keys(state.indexes.pendingInteractions)) {
    const interaction = state.interactions[key];
    if (interaction?.state === "pending") return requestLine(interaction.request);
  }
  return undefined;
}

function requestLine(request: InteractionRequest): string {
  const text = request.kind === "question" ? request.questions[0]?.text : request.title;
  return (
    text
      ?.split("\n")
      .find((part) => part.trim())
      ?.trim() ?? request.kind.replace("_", " ")
  );
}
