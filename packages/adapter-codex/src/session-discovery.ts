import { hydrateControls, parentOf } from "./session-state.ts";
import { rememberHistoricalQuestions } from "./interaction-lifecycle.ts";
import { obj, str, list } from "./native.ts";
/** Discovery is an I/O shell around native history and revision-fenced controls. */
export function sessionDiscovery(config: {
  request(method: string, params: unknown): Promise<unknown>;
  emit(dir: "note", data: unknown): void;
  diagnostic(error: unknown): void;
  schedule(callback: () => void, delay: number): () => void;
  isClosed(): boolean;
  getRoot(): string;
  known: Set<string>;
  recovered: Set<string>;
  parents: Map<string, string>;
  active: Map<string, string>;
  shells: Map<string, string>;
  readRevisions: Map<string, number>;
  revisions: Map<string, number>;
  timers: Map<string, () => void>;
  seenQuestions: Set<string>;
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
    readRevisions,
    revisions,
    timers,
    seenQuestions,
  } = config;
  const recovering = new Set<string>();
  const queueCounts = new Map<string, number>();
  let unknownRecoveries = 0;
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
  async function readThread(threadId: string, ancestors = new Set<string>()): Promise<void> {
    if (ancestors.has(threadId)) throw new Error("Cyclic Codex thread ancestry");
    ancestors.add(threadId);
    const result = obj(await request("thread/read", { threadId, includeTurns: true }));
    const thread = obj(result["thread"]);
    if (str(thread["id"]) !== threadId)
      throw new Error("Codex thread read returned a different id");
    const parent = parentOf(thread);
    if (parent && !known.has(parent)) await readThread(parent, ancestors);
    if (threadId !== config.getRoot() && (!parent || !known.has(parent))) {
      readRevisions.delete(threadId);
      revisions.delete(threadId);
      return;
    }
    if (!Array.isArray(thread["turns"])) throw new Error("Codex read omitted turn history");
    known.add(threadId);
    recovered.add(threadId);
    timers.get(threadId)?.();
    timers.delete(threadId);
    if (parent) parents.set(threadId, parent);
    const revision = readRevisions.get(threadId);
    readRevisions.delete(threadId);
    if (revision === (revisions.get(threadId) ?? 0)) hydrateControls(thread, active, shells);
    rememberHistoricalQuestions(thread, seenQuestions);
    emit("note", { event: "thread-discovered", thread });
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
          if (typeof entry === "string" && !recovered.has(entry)) await readThread(entry);
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
  return { scheduleRecovery, reconcileLoaded, refreshQueue };
}
