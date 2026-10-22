import { isAgentProse } from "@ace/projection";
import { Run, type ThreadId } from "@ace/protocol";
import { z } from "zod";
import type { ServiceContext } from "./services/types.ts";
import type { Store } from "./store.ts";
import type { TurnFacts } from "./automation-run-rules.ts";
import { delegatedChildPersisted } from "./thread-tree.ts";

/**
 * Indexed reads of what one automation run's turn did, for the rules in
 * `automation-run-rules.ts`. Each read touches only the turn's own rows (its runs, the
 * entities it began, the threads it delegated to), never the thread's whole history.
 */

const resultLimit = 8192;

/** A point in the thread: its event sequence and time. */
interface Mark {
  seq: number;
  at: number;
}

export interface TurnRead {
  runIds: readonly string[];
  facts: TurnFacts;
  start: Mark;
  /** Where the thread's next turn began, once one has. */
  later: Mark | undefined;
}

const RunRow = z.object({ id: z.string(), value: z.string(), seq: z.number().nullable() });

/**
 * The turn engine run `runId` belongs to (ADR 0062): the root runs numbered with its turn.
 * Runs recorded before turns were numbered are their own turn.
 */
export function readTurn(
  store: Store,
  threadId: ThreadId,
  runId: string,
  rootAgentId: string | undefined,
): TurnRead | undefined {
  return store.atomic((db) => {
    const turnRow = db
      .prepare("SELECT turn FROM client_run_turn WHERE thread_id=? AND run_id=?")
      .get(threadId, runId);
    const turn = turnRow ? Number(turnRow.turn) : undefined;
    const rows = (
      turn === undefined
        ? db
            .prepare(`SELECT e.id,e.value,w.created_seq AS seq FROM view_entities e
              LEFT JOIN view_entity_windows w ON w.thread_id=e.thread_id AND w.collection='runs' AND w.id=e.id
              WHERE e.thread_id=? AND e.collection='runs' AND e.id=?`)
            .all(threadId, runId)
        : db
            .prepare(`SELECT e.id,e.value,w.created_seq AS seq FROM client_run_turn t
              JOIN view_entities e ON e.thread_id=t.thread_id AND e.collection='runs' AND e.id=t.run_id
              LEFT JOIN view_entity_windows w ON w.thread_id=t.thread_id AND w.collection='runs' AND w.id=t.run_id
              WHERE t.thread_id=? AND t.turn=?`)
            .all(threadId, turn)
    ).map((row) => {
      const parsed = RunRow.parse(row);
      return { run: Run.parse(JSON.parse(parsed.value)), seq: parsed.seq ?? 0 };
    });
    if (!rows.some((row) => row.run.id === runId)) return undefined;
    rows.sort((a, b) => a.seq - b.seq);
    const first = rows[0];
    const last = rows.at(-1);
    if (!first || !last) return undefined;
    const laterRow =
      turn === undefined
        ? db
            .prepare(`SELECT w.created_seq AS seq,e.value FROM view_entity_windows w
              JOIN view_entities e ON e.thread_id=w.thread_id AND e.collection='runs' AND e.id=w.id
              WHERE w.thread_id=? AND w.collection='runs' AND w.created_seq>? AND json_extract(e.value,'$.agentId')=?
              ORDER BY w.created_seq LIMIT 1`)
            .get(threadId, last.seq, rootAgentId ?? "")
        : db
            .prepare(`SELECT w.created_seq AS seq,e.value FROM client_run_turn t
              JOIN view_entity_windows w ON w.thread_id=t.thread_id AND w.collection='runs' AND w.id=t.run_id
              JOIN view_entities e ON e.thread_id=t.thread_id AND e.collection='runs' AND e.id=t.run_id
              WHERE t.thread_id=? AND t.turn>? ORDER BY w.created_seq LIMIT 1`)
            .get(threadId, turn);
    const later = laterRow
      ? {
          seq: Number(laterRow.seq),
          at: Run.parse(JSON.parse(z.string().parse(laterRow.value))).startedAt,
        }
      : undefined;
    return {
      runIds: rows.map((row) => row.run.id),
      facts: {
        active: rows.some((row) => row.run.state === "active"),
        last: last.run.state,
      },
      start: { seq: first.seq, at: first.run.startedAt },
      later,
    };
  });
}

/** The thread's running root run, if one runs. */
export function activeRootRun(
  store: Store,
  threadId: ThreadId,
  rootAgentId: string | undefined,
): string | undefined {
  if (rootAgentId === undefined) return undefined;
  return store.atomic((db) => {
    const row = db
      .prepare(`SELECT w.id FROM view_entity_windows w
        JOIN view_entities e ON e.thread_id=w.thread_id AND e.collection='runs' AND e.id=w.id
        WHERE w.thread_id=? AND w.collection='runs' AND w.active=1 AND json_extract(e.value,'$.agentId')=?
        ORDER BY w.created_seq DESC LIMIT 1`)
      .get(threadId, rootAgentId);
    return row ? z.string().parse(row.id) : undefined;
  });
}

/**
 * Work the turn began in its own thread that is still open: runs of its other agents and
 * background work, or a question waiting on the person. Read once a later turn started.
 */
export function readWindowWork(
  store: Store,
  threadId: ThreadId,
  turn: TurnRead,
): "none" | "working" | "needs-human" {
  return store.atomic((db) => {
    const rows = db
      .prepare(`SELECT collection FROM view_entity_windows WHERE thread_id=? AND active=1
        AND created_seq>=? AND created_seq<? AND collection IN ('runs','backgroundTasks','interactions')
        GROUP BY collection`)
      .all(threadId, turn.start.seq, turn.later?.seq ?? Number.MAX_SAFE_INTEGER)
      .map((row) => z.string().parse(row.collection));
    if (rows.includes("interactions")) return "needs-human";
    return rows.length ? "working" : "none";
  });
}

/**
 * The threads the turn delegated to, with their own descendants: direct children made from
 * its start until the next turn began. Undefined while those children can't be read.
 */
export function turnChildren(
  context: Pick<ServiceContext, "store" | "services">,
  threadId: ThreadId,
  turn: TurnRead,
): ThreadId[] | undefined {
  const journal = context.services.agentControl?.delegations.journal;
  if (!journal) return delegatedChildPersisted(context.store, threadId) ? undefined : [];
  const edges = journal.descendants(threadId);
  const chosen = new Set<ThreadId>(
    edges
      .filter(
        (edge) =>
          edge.parentId === threadId &&
          edge.createdAt >= turn.start.at &&
          (turn.later === undefined || edge.createdAt < turn.later.at),
      )
      .map((edge) => edge.childId),
  );
  // Descendants are listed parents before children at every depth only by id, so repeat.
  for (let depth = 0; depth < 8; depth++)
    for (const edge of edges) if (chosen.has(edge.parentId)) chosen.add(edge.childId);
  return [...chosen];
}

/**
 * What the run answered: the root agent's last prose of its turn, joined and capped. Reads
 * backwards from where the next turn began, a few bounded pages at most.
 */
export function readRunAnswer(
  store: Store,
  threadId: ThreadId,
  rootAgentId: string | undefined,
  turn: TurnRead,
): string | undefined {
  const runs = new Set(turn.runIds);
  let before: number | null = turn.later?.seq ?? store.headSeq() + 1;
  for (let page = 0; page < 5 && before !== null; page++) {
    const read = store.readBoundedItemPage(threadId, before, 40, 256 * 1024);
    for (const item of read.items.toReversed()) {
      const seq = read.itemSeqs?.[item.id];
      if (seq !== undefined && seq < turn.start.seq) return undefined;
      if (!isAgentProse(item) || item.synthetic) continue;
      if (rootAgentId && item.agentId !== rootAgentId) continue;
      if (item.runId !== undefined && !runs.has(item.runId)) continue;
      const text = item.parts
        .flatMap((part) => (part.type === "text" ? [part.text] : []))
        .join("\n")
        .trim();
      if (text) return text.slice(0, resultLimit);
    }
    before = read.itemsBefore;
  }
  return undefined;
}
