import { claudeSessionBoundTask } from "@ace/adapter-claude/session-bound";
import type { Fact, ThreadState } from "@ace/core";
import { ThreadId, type ProviderKind } from "@ace/protocol";
import type { EngineRepository } from "./repository.ts";

/** Provider work that lives inside the provider process and dies with it. */
const sessionBound: Partial<Record<ProviderKind, (key: string, kind: string) => boolean>> = {
  claude: claudeSessionBoundTask,
};

/**
 * Background tasks that ran inside a provider process that is gone. They cannot still be
 * running, so they settle as stopped instead of reading live or lost forever. Call only when
 * no provider session of the thread is live.
 */
export function settleSessionBoundTasks(repo: EngineRepository, state: ThreadState): Fact[] {
  const bound = sessionBound[state.config.provider];
  if (!bound) return [];
  const keys = new Set(Object.keys(state.indexes.runningTasks));
  for (const row of repo.store
    .statement(
      "SELECT key FROM engine_state_records WHERE thread_id=? AND section='tasks' AND json_extract(value,'$.status') IN ('running','unknown')",
    )
    .all(state.threadId))
    if (typeof row.key === "string") keys.add(row.key);
  const facts: Fact[] = [];
  for (const key of keys) {
    const task = state.tasks[key];
    if (!task || task.owner === "ace" || !bound(key, task.kind)) continue;
    if (task.status === "running" || task.status === "unknown")
      facts.push({ type: "background.ended", task: key, status: "stopped" });
  }
  return facts;
}

/**
 * Threads of providers with session-bound work that hold a running or lost task. Startup reads
 * the task index, never history.
 */
export function threadsWithOpenTasks(repo: EngineRepository): ThreadId[] {
  const providers = Object.keys(sessionBound);
  return repo.store
    .statement(
      // Restating the partial index's condition lets SQLite scan it instead of every record.
      `SELECT DISTINCT r.thread_id FROM engine_state_records r JOIN threads t ON t.id=r.thread_id
      WHERE r.section IN ('interactions','tasks') AND r.section='tasks'
      AND json_extract(r.value,'$.status') IN ('running','unknown')
      AND t.provider IN (${providers.map(() => "?").join(",")})`,
    )
    .all(...providers)
    .map((row) => ThreadId.parse(row.thread_id));
}
