import { isAgentProse } from "@ace/projection";
import { Run, type ThreadId } from "@ace/protocol";
import { z } from "zod";
import type { DelegationJournal } from "./agent-control/journal.ts";
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

/** Native work the turn began in its own thread that is still open. */
export interface TurnWork {
  /** Running background tasks that hold the thread open (never ambient helpers). */
  tasks: { id: string; stoppable: boolean }[];
  /** Runs of the thread's other agents (native subagents) still going. */
  agentRuns: { agentId: string; runId: string }[];
  /** Questions still waiting on the person. */
  questions: number;
  /**
   * The provider said another turn of the run's work is coming (background work it started
   * finished, so the agent wakes to read it): its root, while the run's turn is the latest, or
   * one of its own subagents is starting that turn.
   */
  continuing: boolean;
}

const TaskValue = z.object({
  agentId: z.string(),
  status: z.string(),
  ambient: z.boolean().optional(),
  stoppable: z.boolean().optional(),
});
const RunValue = z.object({ agentId: z.string(), state: z.string() });
const OwnedValue = z.object({ agentId: z.string() });
const AgentValue = z.object({
  parentId: z.string().nullable().optional(),
  status: z.object({ state: z.string(), activity: z.string().optional() }).optional(),
});
/** An agent between turns that the provider said is about to start another (`wake.expected`). */
const startingTurn = (value: unknown) => {
  const status = AgentValue.safeParse(value).data?.status;
  return status?.state === "working" && status.activity === "starting_turn";
};

/**
 * The turn's open native work, by cause rather than by when it appeared. A native subagent
 * the turn's root started belongs to the turn, and so does everything it and its own
 * subagents do afterwards, even once a later turn began. The root's own background work and
 * questions belong to the turn they were made in. Reads the thread's open entities through the
 * active-entity index, and only the agents created since the turn began.
 */
export function readTurnWork(
  store: Store,
  threadId: ThreadId,
  turn: TurnRead,
  rootAgentId: string | undefined,
): TurnWork {
  return store.atomic((db) => {
    const end = turn.later?.seq ?? Number.MAX_SAFE_INTEGER;
    const inTurn = (seq: number) => seq >= turn.start.seq && seq < end;
    // Agents the turn's root started, and the agents those started in turn.
    const owned = new Set<string>();
    const agents = db
      .prepare(`SELECT e.id,e.value,w.created_seq AS seq FROM view_entity_windows w
        JOIN view_entities e ON e.thread_id=w.thread_id AND e.collection=w.collection AND e.id=w.id
        WHERE w.thread_id=? AND w.collection='agents' AND w.created_seq>=? ORDER BY w.created_seq`)
      .all(threadId, turn.start.seq)
      .map((row) => {
        const value: unknown = JSON.parse(z.string().parse(row.value));
        return {
          id: z.string().parse(row.id),
          parent: AgentValue.safeParse(value).data?.parentId,
          starting: startingTurn(value),
          seq: Number(row.seq),
        };
      });
    for (const agent of agents)
      if (agent.id !== rootAgentId)
        if (agent.parent === rootAgentId ? inTurn(agent.seq) : owned.has(agent.parent ?? ""))
          owned.add(agent.id);
    const open = (collection: string) =>
      db
        .prepare(`SELECT e.id,e.value,w.created_seq AS seq FROM view_entity_windows w
          JOIN view_entities e ON e.thread_id=w.thread_id AND e.collection=w.collection AND e.id=w.id
          WHERE w.thread_id=? AND w.collection=? AND w.active=1`)
        .all(threadId, collection)
        .map((row) => ({
          id: z.string().parse(row.id),
          value: JSON.parse(z.string().parse(row.value)),
          seq: Number(row.seq),
        }));
    const ours = (agentId: string, seq: number) =>
      owned.has(agentId) || (agentId === rootAgentId && inTurn(seq));
    const tasks = open("backgroundTasks").flatMap(({ id, value, seq }) => {
      const task = TaskValue.safeParse(value);
      return task.success &&
        task.data.status === "running" &&
        !task.data.ambient &&
        ours(task.data.agentId, seq)
        ? [{ id, stoppable: task.data.stoppable === true }]
        : [];
    });
    const agentRuns = open("runs").flatMap(({ id, value }) => {
      const run = RunValue.safeParse(value);
      return run.success && run.data.state === "active" && owned.has(run.data.agentId)
        ? [{ agentId: run.data.agentId, runId: id }]
        : [];
    });
    const questions = open("interactions").filter(({ value, seq }) => {
      const owner = OwnedValue.safeParse(value);
      return owner.success && ours(owner.data.agentId, seq);
    }).length;
    const root = rootAgentId
      ? db
          .prepare(
            "SELECT value FROM view_entities WHERE thread_id=? AND collection='agents' AND id=?",
          )
          .get(threadId, rootAgentId)
      : undefined;
    const continuing =
      (turn.later === undefined &&
        root !== undefined &&
        startingTurn(JSON.parse(z.string().parse(root.value)))) ||
      agents.some((agent) => agent.starting && owned.has(agent.id));
    return { tasks, agentRuns, questions, continuing };
  });
}

/**
 * The delegated work the turn began (`DelegationOrigins`): children whose current generation
 * one of the turn's runs asked for, settled or not, so a child that failed still counts in how
 * the run went; then, level by level, each owned child's own children whose current generation
 * that child's agents asked for during its owned generation. Work someone else started or
 * reopened anywhere below is not the run's. `uncertain` is live work, at any level, whose owner
 * nobody can establish (from before owners were kept): it holds the run open and is never
 * stopped for it. Reservations are preparations of children for owned threads. Undefined while
 * delegated children can't be read.
 */
export function turnDelegations(
  store: Store,
  journal: DelegationJournal | undefined,
  threadId: ThreadId,
  turn: TurnRead,
): { children: ThreadId[]; reservations: ThreadId[]; uncertain: ThreadId[] } | undefined {
  if (!journal)
    return delegatedChildPersisted(store, threadId)
      ? undefined
      : { children: [], reservations: [], uncertain: [] };
  const origins = journal.origins;
  const children: ThreadId[] = [];
  const reservations: ThreadId[] = [];
  const uncertain: ThreadId[] = [];
  const pending: { thread: ThreadId; since: number }[] = [];
  const own = (child: ThreadId, generation: number) => {
    children.push(child);
    pending.push({ thread: child, since: origins.owner(child, generation)?.seq ?? 0 });
  };
  for (const { child, generation } of origins.byRuns(threadId, turn.runIds)) {
    const edge = journal.get(child);
    if (edge?.generation === generation) own(child, generation);
    else if (!edge && generation === 0 && journal.reservationOf(child)) reservations.push(child);
  }
  for (const edge of journal.liveChildren(threadId))
    if (!children.includes(edge.childId) && origins.uncertain(edge.childId, edge.generation))
      uncertain.push(edge.childId);
  for (let next = pending.shift(); next && children.length < 64; next = pending.shift()) {
    for (const edge of journal.children(next.thread)) {
      const owner = origins.owner(edge.childId, edge.generation);
      if (!owner || owner.kind === "uncertain") {
        if (edge.phase !== "settled") uncertain.push(edge.childId);
      } else if (owner.kind === "turn" && owner.seq >= next.since)
        own(edge.childId, edge.generation);
    }
    for (const reservation of journal.reservations())
      if (reservation.record.parentId === next.thread) {
        const owner = origins.owner(reservation.record.childId, 0);
        if (owner?.kind === "turn" && owner.seq >= next.since)
          reservations.push(reservation.record.childId);
      }
  }
  return { children, reservations, uncertain };
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
