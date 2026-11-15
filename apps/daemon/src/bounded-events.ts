import type { Event, ThreadId } from "@ace/protocol";
import type { DatabaseSync } from "@ace/provider-kit/sqlite";
import { storedEvent, type StoredTrust } from "./stored-decode.ts";

/*
 * A thread's events read under a limit that is enforced before anything is decoded (ADR 0155,
 * reads before an NK session confirms): the rows' stored sizes come from the record headers
 * (`octet_length` reads no content), and only a range that fits both the row and the byte limit
 * is read and decoded. A range that doesn't fit reads nothing.
 */

/** The JSON a stored event adds around its payload: seq, id, time, thread id and the keys. */
const ENVELOPE_BYTES = 64;

export class BoundedEvents {
  readonly #db: () => DatabaseSync;
  readonly #trust: StoredTrust;
  readonly #flush: () => void;
  constructor(db: () => DatabaseSync, trust: StoredTrust, flush: () => void) {
    this.#db = db;
    this.#trust = trust;
    this.#flush = flush;
  }

  /**
   * The thread's events in (afterSeq, throughSeq], with the bytes they take, when there are at
   * most `rows` of them taking at most `bytes`; otherwise undefined, having decoded nothing.
   */
  threadEvents(
    threadId: ThreadId,
    afterSeq: number,
    throughSeq: number,
    limit: { rows: number; bytes: number },
  ): { events: Event[]; bytes: number } | undefined {
    this.#flush();
    const db = this.#db();
    const sizes = db
      .prepare(
        "SELECT octet_length(payload) + octet_length(id) + octet_length(thread_id) AS size FROM events WHERE thread_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?",
      )
      .all(threadId, afterSeq, throughSeq, limit.rows + 1);
    if (sizes.length > limit.rows) return undefined;
    let stored = 0;
    for (const row of sizes) stored += Number(row.size) + ENVELOPE_BYTES;
    if (stored > limit.bytes) return undefined;
    const events: Event[] = [];
    let bytes = 0;
    for (const row of db
      .prepare(
        "SELECT * FROM events WHERE thread_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?",
      )
      .iterate(threadId, afterSeq, throughSeq, limit.rows)) {
      const { event, bytes: size } = storedEvent(row, this.#trust);
      bytes += size;
      // A trusted row's measure equals what the header promised; an untrusted one is re-encoded.
      if (bytes > limit.bytes) return undefined;
      events.push(event);
    }
    return { events, bytes };
  }
}
