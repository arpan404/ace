import { createHash } from "node:crypto";
import type { DatabaseSync } from "@ace/provider-kit/sqlite";
import { z } from "zod";
import {
  OffshiftPhase,
  OffshiftRequest,
  OffshiftRun,
  type OffshiftResult,
  type OffshiftRoles,
  type OffshiftView,
} from "@ace/protocol/offshift";
import { OffshiftError, transition, view, type Context } from "./workflow.ts";

const stored = z.object({ body: z.string() });
const receipt = z.object({ input: z.string() });
/** Synchronous host transaction: state and idempotency receipts commit together. */
export interface Transactions {
  atomic<T>(work: (db: DatabaseSync) => T): T;
}
/**
 * What a call did: `changed` holds the new view only when this call wrote the run, so the host
 * can publish a change inside the same transaction. Reads and receipt replays leave it out.
 */
export interface Executed {
  result: OffshiftResult;
  changed?: OffshiftView;
}
export class OffshiftJournal {
  private readonly transactions: Transactions;
  constructor(transactions: Transactions) {
    this.transactions = transactions;
    transactions.atomic((db) =>
      db.exec(`
      CREATE TABLE IF NOT EXISTS offshift_runs (
        thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
        id TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY(thread_id,id));
      CREATE TABLE IF NOT EXISTS offshift_receipts (
        thread_id TEXT NOT NULL, run_id TEXT NOT NULL, request_id TEXT NOT NULL, input TEXT NOT NULL,
        PRIMARY KEY(thread_id,run_id,request_id),
        FOREIGN KEY(thread_id,run_id) REFERENCES offshift_runs(thread_id,id) ON DELETE CASCADE);
    `),
    );
  }
  /**
   * The roles of the thread's most recently updated run not yet in delivery: the run a
   * delegation by role works for. Undefined when the thread has none.
   */
  activeRoles(threadId: string): OffshiftRoles | undefined {
    return this.transactions.atomic((db) => {
      const row = db
        .prepare(
          "SELECT body FROM offshift_runs WHERE thread_id=? AND json_extract(body,'$.phase')<>'delivery' ORDER BY json_extract(body,'$.updatedAt') DESC, id LIMIT 1",
        )
        .get(threadId);
      return row ? OffshiftRun.parse(JSON.parse(stored.parse(row).body)).roles : undefined;
    });
  }
  execute(input: unknown, context: Context): Executed {
    const request = OffshiftRequest.parse(input);
    return this.transactions.atomic((db): Executed => {
      if (request.action === "list") {
        if (context.caller.threadId !== context.threadId)
          throw new OffshiftError("list reads only your own runs; call it without runOwner");
        // Metadata only: evidence bodies never multiply the MCP result size.
        const result = db
          .prepare(
            "SELECT id, json_extract(body,'$.outcome') AS outcome, json_extract(body,'$.phase') AS phase FROM offshift_runs WHERE thread_id=? ORDER BY id LIMIT 32",
          )
          .all(context.threadId)
          .map((row) => {
            const item = z
              .object({ id: z.string(), outcome: z.string(), phase: OffshiftPhase })
              .parse(row);
            // Bound encoded bytes too: 32 full Unicode outcomes can exceed the MCP budget.
            const outcome = Array.from(item.outcome).slice(0, 128).join("");
            return {
              id: item.id,
              phase: item.phase,
              outcome,
              outcomeTruncated: outcome !== item.outcome,
            };
          });
        return { result };
      }
      const row = db
        .prepare("SELECT body FROM offshift_runs WHERE thread_id=? AND id=?")
        .get(context.threadId, request.runId);
      const current = row ? OffshiftRun.parse(JSON.parse(stored.parse(row).body)) : undefined;
      if (request.action === "get") {
        if (!current)
          throw new OffshiftError(
            `Run not found in the calling thread; call list to see its runs${context.caller.threadId === context.threadId ? "" : ", or check runOwner"}`,
          );
        return { result: view(current, context) };
      }
      // The receipt names who asked, so another thread's identical request is never a replay.
      const encoded = JSON.stringify({ request, by: context.caller.threadId });
      // Without a requestId the normalized request (version included) is its own key: a retry
      // after a lost response hashes the same and applies once. ":" never occurs in a given id.
      const requestId =
        request.requestId ?? `auto:${createHash("sha256").update(encoded).digest("hex")}`;
      const prior = db
        .prepare(
          "SELECT input FROM offshift_receipts WHERE thread_id=? AND run_id=? AND request_id=?",
        )
        .get(context.threadId, request.runId, requestId);
      if (prior) {
        if (receipt.parse(prior).input !== encoded)
          throw new OffshiftError("requestId was already used for a different operation");
        if (!current) throw new OffshiftError("Run receipt has no run");
        // A receipt prevents replay, but never replays a stale completion observation.
        return { result: view(current, context) };
      }
      if (request.action === "start") {
        const count = z
          .object({ n: z.number() })
          .parse(
            db
              .prepare("SELECT count(*) AS n FROM offshift_runs WHERE thread_id=?")
              .get(context.threadId),
          );
        if (count.n >= 32) throw new OffshiftError("Thread run limit reached");
      }
      if (current && current.version >= 512)
        throw new OffshiftError("Run mutation limit reached; start a new run");
      const next = transition(current, request, context);
      const body = JSON.stringify(next);
      if (Buffer.byteLength(body) > 49152)
        throw new OffshiftError(
          "Run exceeds the 48 KiB evidence budget; use concise summaries and artifact references",
        );
      db.prepare(
        "INSERT INTO offshift_runs(thread_id,id,body) VALUES (?,?,?) ON CONFLICT(thread_id,id) DO UPDATE SET body=excluded.body",
      ).run(context.threadId, request.runId, body);
      db.prepare(
        "INSERT INTO offshift_receipts(thread_id,run_id,request_id,input) VALUES (?,?,?,?)",
      ).run(context.threadId, request.runId, requestId, encoded);
      const changed = view(next, context);
      return { result: changed, changed };
    });
  }
}
