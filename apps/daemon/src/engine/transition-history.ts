import { z } from "zod";
import { Item, Run, type ForkPoint, type ThreadId } from "@ace/protocol";
import { selectHandoff } from "@ace/handoff";
import type { EngineRepository } from "./repository.ts";
import type { ThreadState } from "@ace/core";

/** A quota-limited terminal run can branch, but live trees cannot be switched away. */
export function quiescent(state: ThreadState, agentsReady: boolean): boolean {
  if (state.queueSources.provider || state.processExit?.unsettled?.length) return false;
  if (
    Object.keys(state.indexes.liveTools).length ||
    Object.keys(state.indexes.pendingInteractions).length ||
    Object.keys(state.indexes.runningTasks).length ||
    Object.keys(state.uncertainTasks ?? {}).length
  )
    return false;
  return agentsReady;
}
export function boundary(repo: EngineRepository, id: ThreadId, point: ForkPoint) {
  return repo.store.atomic((db) => {
    const root = repo.requireState(id).agents[repo.requireState(id).rootKey ?? ""]?.agent;
    if (!root) throw new Error("Source root is unavailable");
    if (point.type === "turn") {
      const row = db
        .prepare("SELECT value FROM view_entities WHERE thread_id=? AND collection='runs' AND id=?")
        .get(id, point.runId);
      const run = Run.parse(row ? JSON.parse(String(row.value)) : undefined);
      if (run.state === "active" || run.endedAt === undefined)
        throw new Error("Fork point must be a finished run");
      const end = db
        .prepare(
          "SELECT seq FROM events WHERE thread_id=? AND type='run.ended' AND json_extract(payload,'$.runId')=? ORDER BY seq DESC LIMIT 1",
        )
        .get(id, point.runId);
      if (!end) throw new Error("Fork boundary is unavailable");
      return {
        throughSeq: z.number().int().positive().parse(end.seq),
        parentAgentId: run.agentId,
        sourceAgent:
          repo.requireState(id).agents[
            repo.requireState(id).indexes.agentKeysById[run.agentId] ?? ""
          ]?.agent,
        atSessionEnd:
          repo.requireState(id).agents[repo.requireState(id).rootKey ?? ""]?.lastRun === run.id &&
          run.agentId === root.id &&
          repo.quiescent(repo.requireState(id)),
        ...(run.nativeId ? { native: { type: "turn" as const, nativeId: run.nativeId } } : {}),
      };
    }
    const row = db
      .prepare(
        "SELECT h.created_seq,p.item FROM item_heads h JOIN item_previews p ON p.id=h.id WHERE h.thread_id=? AND h.id=?",
      )
      .get(id, point.itemId);
    const item = Item.parse(row ? JSON.parse(String(row.item)) : undefined);
    if (!item.complete || !item.agentId || !item.runId)
      throw new Error("Fork point must be a finished agent item in a run");
    const runRow = db
      .prepare("SELECT value FROM view_entities WHERE thread_id=? AND collection='runs' AND id=?")
      .get(id, item.runId);
    if (Run.parse(runRow ? JSON.parse(String(runRow.value)) : undefined).state === "active")
      throw new Error("Fork point belongs to an unfinished run");
    return {
      throughSeq: z.number().int().positive().parse(row?.created_seq),
      parentAgentId: item.agentId,
      sourceAgent:
        repo.requireState(id).agents[
          repo.requireState(id).indexes.agentKeysById[item.agentId] ?? ""
        ]?.agent,
      atSessionEnd: false,
      ...(item.nativeId ? { native: { type: "item" as const, nativeId: item.nativeId } } : {}),
    };
  });
}
export function handoff(repo: EngineRepository, id: ThreadId, throughSeq: number, budget: number) {
  const totalItems = repo.store.atomic((db) =>
    Number(
      db
        .prepare("SELECT COUNT(*) AS n FROM item_heads WHERE thread_id=? AND created_seq<=?")
        .get(id, throughSeq)?.n,
    ),
  );
  const page = repo.store.readItemPage(id, throughSeq + 1, 200, 1024 * 1024);
  return selectHandoff({ threadId: id, throughSeq, totalItems, items: page.items }, budget);
}
export function validateCitations(
  repo: EngineRepository,
  id: ThreadId,
  itemIds: readonly string[],
): void {
  repo.store.atomic((db) => {
    const find = db.prepare("SELECT id FROM item_heads WHERE thread_id=? AND id=?");
    for (const itemId of itemIds)
      if (!find.get(id, itemId)) throw new Error("Citation does not belong to fork");
  });
}
