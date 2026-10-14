import {
  hydrateControls,
  parentOf,
  recoveryUncertain,
  type ReadObservation,
} from "./session-state.ts";
import { RecentSet } from "./retention.ts";
import { rememberHistoricalQuestions } from "./interaction-lifecycle.ts";
import { obj, str, list } from "./native.ts";
import { historyNotes, readHistory, withoutHistory } from "./history.ts";
/** Discovery is an I/O shell around native history and revision-fenced controls. */
export function sessionDiscovery(config: {
  request(method: string, params: unknown): Promise<unknown>;
  emit(dir: "note", data: unknown): void;
  diagnostic(error: unknown): void;
  schedule(callback: () => void, delay: number): () => void;
  isClosed(): boolean;
  /** Owned by another session on a shared app-server; never part of this tree. */
  isForeign(threadId: string): boolean;
  getRoot(): string;
  known: Set<string>;
  recovered: Set<string>;
  parents: Map<string, string>;
  active: Map<string, string>;
  shells: Map<string, string>;
  reading: Set<string>;
  revisions: Map<string, number>;
  timers: Map<string, () => void>;
  seenQuestions: Set<string>;
  /** Turns already seen completing live; a history snapshot cannot make them active again. */
  endedTurns: { has(turn: string): boolean };
}) {
  const {
    request,
    emit,
    diagnostic,
    known,
    recovered,
    parents,
    active,
    shells,
    reading,
    revisions,
    timers,
    seenQuestions,
    endedTurns,
  } = config;
  const recovering = new Set<string>();
  const reads = new Map<string, Promise<void>>();
  const observations = new Map<string, ReadObservation>();
  const dependencies = new Map<string, string>();
  const queueCounts = new Map<string, number>();
  let unknownRecoveries = 0;
  let historyReads = 0;
  function scheduleRecovery(threadId: string): void {
    if (config.isClosed() || timers.has(threadId)) return;
    timers.set(
      threadId,
      config.schedule(() => {
        timers.delete(threadId);
        if (!config.isClosed()) void recoverThread(threadId);
      }, 2_000),
    );
  }
  async function recoverThread(threadId: string): Promise<void> {
    if (recovering.has(threadId) || recovered.has(threadId) || config.isClosed()) return;
    const unknown = !known.has(threadId);
    // Reserve capacity for admitted children and control commands. A saturated
    // unknown-thread timer batch must not exhaust the peer's bounded RPC queue.
    if (recovering.size >= 8 || (unknown && unknownRecoveries >= 4)) {
      scheduleRecovery(threadId);
      return;
    }
    recovering.add(threadId);
    if (unknown) unknownRecoveries++;
    try {
      await readThread(threadId);
    } catch (error) {
      diagnostic(error);
      scheduleRecovery(threadId);
    } finally {
      recovering.delete(threadId);
      if (unknown) unknownRecoveries--;
    }
  }
  function readThread(threadId: string, ancestors = new Set<string>()): Promise<void> {
    if (ancestors.has(threadId)) throw new Error("Cyclic Codex thread ancestry");
    const pending = reads.get(threadId);
    if (pending) return pending;
    reading.add(threadId);
    const observed = { completed: new RecentSet() };
    observations.set(threadId, observed);
    const read = readSnapshot(threadId, new Set(ancestors).add(threadId), observed);
    reads.set(threadId, read);
    const release = () => {
      reads.delete(threadId);
      reading.delete(threadId);
      observations.delete(threadId);
      dependencies.delete(threadId);
    };
    void read.then(release, release);
    return read;
  }
  async function readSnapshot(
    threadId: string,
    ancestors: Set<string>,
    observed: ReadObservation,
  ): Promise<void> {
    // This evidence belongs to this request, including while ancestry is being loaded.
    const revision = revisions.get(threadId) ?? 0;
    // Metadata only: history arrives in bounded pages below (#693).
    const result = obj(await request("thread/read", { threadId }));
    const thread = withoutHistory(obj(result["thread"]));
    if (str(thread["id"]) !== threadId)
      throw new Error("Codex thread read returned a different id");
    // The session's own root is the top of its tree, whatever Codex records above it.
    const parent = threadId === config.getRoot() ? "" : parentOf(thread);
    if (parent && !known.has(parent)) {
      dependencies.set(threadId, parent);
      const seen = new Set(ancestors);
      for (let next = parent; next; next = dependencies.get(next) ?? "") {
        if (seen.has(next)) throw new Error("Cyclic Codex thread ancestry");
        seen.add(next);
      }
      await readThread(parent, ancestors);
    }
    if (threadId !== config.getRoot() && (!parent || !known.has(parent))) {
      revisions.delete(threadId);
      return;
    }
    const snapshot = { ...thread, turns: await readHistory(request, threadId) };
    known.add(threadId);
    if (parent) parents.set(threadId, parent);
    const current = revisions.get(threadId) ?? 0;
    const evidence = { read: revision, current };
    const uncertain = recoveryUncertain(snapshot, evidence, observed);
    if (uncertain) {
      recovered.delete(threadId);
      scheduleRecovery(threadId);
    } else {
      recovered.add(threadId);
      timers.get(threadId)?.();
      timers.delete(threadId);
    }
    if (revision === current) hydrateControls(snapshot, active, shells, endedTurns);
    rememberHistoricalQuestions(snapshot, seenQuestions);
    const read = ++historyReads;
    for (const note of historyNotes(threadId, read, snapshot.turns)) emit("note", note);
    emit("note", {
      event: "thread-discovered",
      thread: { ...thread, turns: [] },
      history: read,
      revision: { ...evidence, uncertain },
    });
  }
  async function refreshQueue(threadId: string): Promise<void> {
    let cursor: unknown = undefined;
    let count = 0;
    do {
      const result = obj(
        await request("thread/queue/list", { threadId, ...(cursor ? { cursor } : {}) }),
      );
      count += list(result["data"]).length;
      cursor = result["nextCursor"];
    } while (cursor);
    queueCounts.set(threadId, count);
    emit("note", {
      event: "queue-state",
      count: [...queueCounts.values()].reduce((total, value) => total + value, 0),
    });
  }
  async function reconcileLoaded(task: string): Promise<void> {
    try {
      let cursor: unknown = undefined;
      do {
        const result = obj(await request("thread/loaded/list", cursor ? { cursor } : {}));
        for (const entry of list(result["data"]))
          if (typeof entry === "string" && !recovered.has(entry) && !config.isForeign(entry))
            await readThread(entry);
        cursor = result["nextCursor"];
      } while (cursor);
      if (!config.isClosed())
        emit("note", { event: "discovery-finished", threadId: config.getRoot(), task });
    } catch (error) {
      diagnostic(error);
      if (!config.isClosed() && !timers.has(task))
        timers.set(
          task,
          config.schedule(() => {
            timers.delete(task);
            if (!config.isClosed()) void reconcileLoaded(task);
          }, 2_000),
        );
    }
  }
  function observeRecovery(thread: string, method: string, turn: string): void {
    const observed = observations.get(thread);
    if (!observed || !turn) return;
    if (method === "turn/started") observed.started = turn;
    if (method === "turn/completed") observed.completed.add(turn);
  }
  return { scheduleRecovery, reconcileLoaded, refreshQueue, observeRecovery, readThread };
}
