import type {
  AgentControlResult,
  DelegationOutcome,
  Event,
  McpAttribution,
  MonitorSnapshot,
  MonitoredChild,
  Thread,
  ThreadId,
  WaitMode,
  WaitResult,
  WaitStatus,
  WatchedRequest,
  WatchedState,
  WatchedThread,
} from "@ace/protocol";
import type { EngineClock } from "../engine/actor.ts";
import type { Store } from "../store.ts";
import type { DelegationJournal } from "./journal.ts";
import { threadOutcome } from "./results.ts";
import {
  agentStep,
  clip,
  elapsedSeconds,
  lastLine,
  requestPrompt,
  settledStates,
  waitOutcome,
  watchedState,
} from "./watch-view.ts";

export interface MonitorDependencies {
  store: Store;
  journal: DelegationJournal;
  clock: EngineClock;
  authorize(caller: McpAttribution, target: ThreadId, write: boolean): boolean;
  /** Hands a result read inside the tool call to the parent, so no wake repeats it. */
  delivered(caller: McpAttribution, outcome: DelegationOutcome): void;
}
/** Children that run on other paired machines (ADR 0078), observed by their own poller. */
export interface RemoteChildren {
  /** The caller delegated this child to another machine. */
  owns(caller: McpAttribution, id: ThreadId): boolean;
  watched(id: ThreadId): { view: WatchedThread; outcome?: DelegationOutcome } | undefined;
  children(caller: McpAttribution): MonitoredChild[];
  /** A wait read this settled result, so it is not delivered again as a wake. */
  delivered(id: ThreadId): void;
  subscribe(listener: (ids: readonly string[]) => void): () => void;
}
interface PendingWait {
  ids: readonly ThreadId[];
  mode: WaitMode;
  caller: McpAttribution;
  scheduled: boolean;
  finish(status: WaitStatus): void;
}
const maxWaits = 64;
const maxWaitsPerCaller = 16;

/**
 * Bounded waits and compact snapshots over the canonical thread status and delegation journal.
 * Waits observe store changes for the watched threads only; ending a wait never cancels work.
 */
export class AgentMonitor {
  private deps: MonitorDependencies;
  private waits = new Set<PendingWait>();
  private closed = false;
  private unsubscribe: () => void;
  private remote: RemoteChildren | undefined;
  private stopRemote: (() => void) | undefined;
  constructor(deps: MonitorDependencies) {
    this.deps = deps;
    this.unsubscribe = deps.store.subscribe((events) => this.observe(events));
  }
  /** Children on other machines join waits and snapshots once their owner starts. */
  attachRemote(remote: RemoteChildren) {
    this.stopRemote?.();
    this.remote = remote;
    this.stopRemote = remote.subscribe((ids) => this.recheck(new Set(ids)));
  }
  /** Whether a live wait is watching this thread, so its result is read there, not woken. */
  watching(id: ThreadId): boolean {
    for (const wait of this.waits) if (wait.ids.includes(id)) return true;
    return false;
  }
  /** Waits on children the caller delegated or any other thread it may read. */
  async wait(
    caller: McpAttribution,
    input: { threadIds: readonly ThreadId[]; mode: WaitMode; timeoutSeconds: number },
    signal: AbortSignal,
  ): Promise<AgentControlResult> {
    signal.throwIfAborted();
    const ids = [...new Set(input.threadIds)];
    for (const id of ids)
      if (
        !this.remote?.owns(caller, id) &&
        (!this.deps.store.getThread(id) || !this.deps.authorize(caller, id, false))
      )
        return { ok: false, code: "forbidden", data: { threadId: id } };
    if (this.closed) return { ok: true, data: this.interrupted(ids, input.mode) };
    const immediate = waitOutcome(
      ids.map((id) => this.state(id)),
      input.mode,
    );
    if (immediate) return { ok: true, data: this.respond(caller, ids, input.mode, immediate) };
    const mine = [...this.waits].filter((wait) => wait.caller.threadId === caller.threadId).length;
    if (this.waits.size >= maxWaits || mine >= maxWaitsPerCaller)
      return { ok: false, code: "limit" };
    const status = await new Promise<WaitStatus | WaitResult>((resolve, reject) => {
      const cancelTimer = this.deps.clock.setTimer(
        () => wait.finish("timeout"),
        input.timeoutSeconds * 1000,
      );
      const abort = () => {
        cleanup();
        reject(signal.reason);
      };
      const cleanup = () => {
        cancelTimer();
        signal.removeEventListener("abort", abort);
        this.waits.delete(wait);
      };
      const wait: PendingWait = {
        ids,
        mode: input.mode,
        caller,
        scheduled: false,
        finish: (value) => {
          cleanup();
          // Shutdown reads state now, while the store is still open.
          resolve(value === "interrupted" ? this.interrupted(ids, input.mode) : value);
        },
      };
      this.waits.add(wait);
      signal.addEventListener("abort", abort, { once: true });
    });
    signal.throwIfAborted();
    return {
      ok: true,
      data: typeof status === "string" ? this.respond(caller, ids, input.mode, status) : status,
    };
  }
  /** Every delegated descendant of the caller, a few short fields each. */
  snapshot(caller: McpAttribution): MonitorSnapshot {
    const root = this.deps.journal.get(caller.threadId)?.rootId ?? caller.threadId;
    const now = this.deps.clock.now();
    const counts: Record<WatchedState, number> = {
      working: 0,
      needs_you: 0,
      done: 0,
      failed: 0,
      cancelled: 0,
    };
    const children: MonitoredChild[] = [];
    for (const edge of this.deps.journal.family(root)) {
      if (!this.deps.journal.isDescendant(edge.childId, caller.threadId)) continue;
      const thread = this.deps.store.getThread(edge.childId);
      if (!thread) continue;
      const state = this.state(thread.id);
      counts[state]++;
      const needs = state === "needs_you" ? this.needs(thread) : [];
      const step = state === "working" ? this.step(thread) : undefined;
      const last = state === "working" ? this.lastOutput(thread, 100) : undefined;
      children.push({
        id: thread.id,
        ...(edge.parentId === caller.threadId ? {} : { parent: edge.parentId }),
        role: clip(edge.request.role, 40),
        state,
        ...(step ? { step: clip(step, 60) } : {}),
        elapsedSeconds: elapsedSeconds(
          edge.createdAt,
          settledStates.has(state) ? thread.updatedAt : now,
        ),
        ...(needs[0] ? { needs: needs.length, ask: clip(needs[0].prompt, 100) } : {}),
        ...(last ? { last } : {}),
      });
    }
    for (const child of this.remote?.children(caller) ?? []) {
      if (children.length >= 64) break;
      counts[child.state]++;
      children.push(child);
    }
    return { children, counts };
  }
  /** Resolves every pending wait as `interrupted`, so a restart never leaves a caller hanging. */
  close() {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribe();
    this.stopRemote?.();
    for (const wait of this.waits) wait.finish("interrupted");
  }
  private observe(events: readonly Event[]) {
    if (!this.waits.size) return;
    const touched = new Set<string>();
    for (const event of events) touched.add(event.threadId);
    this.recheck(touched);
  }
  private recheck(touched: ReadonlySet<string>) {
    for (const wait of this.waits)
      if (!wait.scheduled && wait.ids.some((id) => touched.has(id))) {
        // The delegation owner settles journal edges in its own listener for the same batch.
        wait.scheduled = true;
        queueMicrotask(() => {
          wait.scheduled = false;
          if (!this.waits.has(wait)) return;
          const status = waitOutcome(
            wait.ids.map((id) => this.state(id)),
            wait.mode,
          );
          if (status) wait.finish(status);
        });
      }
  }
  private state(id: ThreadId): WatchedState {
    const remote = this.remote?.watched(id);
    if (remote) return remote.view.state;
    const thread = this.deps.store.getThread(id);
    if (!thread || thread.deletedAt !== undefined) return "cancelled";
    const record = this.deps.journal.get(id);
    const pending =
      !!record &&
      this.deps.journal
        .family(record.rootId)
        .some(
          (edge) => edge.phase !== "settled" && this.deps.journal.isDescendant(edge.childId, id),
        );
    const root = thread.rootAgentId && this.deps.store.getMcpAgent(thread.id, thread.rootAgentId);
    return watchedState(
      thread,
      record,
      pending,
      !!root && ["idle", "blocked", "interrupted"].includes(root.status.state),
    );
  }
  /** Reads every watched thread, then hands settled results to the parent exactly once. */
  private respond(
    caller: McpAttribution,
    ids: readonly ThreadId[],
    mode: WaitMode,
    status: WaitStatus,
  ): WaitResult {
    const read = ids.map((id) => this.watched(id));
    for (const entry of read)
      if (entry.outcome) {
        if (this.remote?.owns(caller, entry.outcome.threadId))
          this.remote.delivered(entry.outcome.threadId);
        else this.deps.delivered(caller, entry.outcome);
      }
    return { status, mode, threads: read.map((entry) => entry.view) };
  }
  /** Never fails: a restart answers with whatever is still readable. */
  private interrupted(ids: readonly ThreadId[], mode: WaitMode): WaitResult {
    let threads: WatchedThread[];
    try {
      threads = ids.map((id) => this.watched(id).view);
    } catch {
      threads = ids.map((id) => ({ threadId: id, state: "working", title: "", elapsedSeconds: 0 }));
    }
    return { status: "interrupted", mode, threads };
  }
  private watched(id: ThreadId): { view: WatchedThread; outcome?: DelegationOutcome } {
    const remote = this.remote?.watched(id);
    if (remote) return remote;
    const thread = this.deps.store.getThread(id);
    if (!thread)
      return { view: { threadId: id, state: "cancelled", title: "", elapsedSeconds: 0 } };
    const state = this.state(id);
    const record = this.deps.journal.get(id);
    const settled = settledStates.has(state);
    const base = {
      threadId: id,
      state,
      title: clip(thread.title, 120),
      elapsedSeconds: elapsedSeconds(
        record?.createdAt ?? thread.createdAt,
        settled ? thread.updatedAt : this.deps.clock.now(),
      ),
    };
    if (settled) {
      const outcome =
        record?.phase === "settled" && record.outcome
          ? record.outcome
          : threadOutcome(this.deps.store, thread, state === "cancelled");
      return { view: { ...base, result: outcome.result, truncated: outcome.truncated }, outcome };
    }
    const needs = state === "needs_you" ? this.needs(thread) : [];
    const step = this.step(thread);
    const last = this.lastOutput(thread, 160);
    return {
      view: {
        ...base,
        ...(step ? { step: clip(step, 120) } : {}),
        ...(last ? { last } : {}),
        ...(needs.length ? { needs } : {}),
      },
    };
  }
  private step(thread: Thread): string | undefined {
    const root = thread.rootAgentId && this.deps.store.getMcpAgent(thread.id, thread.rootAgentId);
    return root ? agentStep(root.status) : undefined;
  }
  /** Requests from the thread and its delegated descendants, oldest first, at most eight. */
  private needs(thread: Thread): WatchedRequest[] {
    const asking = [...(thread.live?.asking ?? [])];
    const record = this.deps.journal.get(thread.id);
    for (const edge of this.deps.journal.family(record?.rootId ?? thread.id)) {
      if (asking.length >= 8) break;
      if (!this.deps.journal.isDescendant(edge.childId, thread.id)) continue;
      asking.push(...(this.deps.store.getThread(edge.childId)?.live?.asking ?? []));
    }
    return asking.slice(0, 8).flatMap((entry) => {
      const interaction = this.deps.store.getInteraction(entry.id);
      if (!interaction || interaction.state !== "pending") return [];
      return [
        {
          interactionId: interaction.id,
          kind: interaction.request.kind,
          prompt: clip(requestPrompt(interaction.request), 240),
        },
      ];
    });
  }
  /** The newest assistant output line, from one small page. */
  private lastOutput(thread: Thread, max: number): string | undefined {
    const page = this.deps.store.readItemPage(thread.id, this.deps.store.headSeq() + 1, 5, 16384);
    for (let index = page.items.length - 1; index >= 0; index--) {
      const item = page.items[index];
      if (item?.type !== "message" || item.role !== "assistant") continue;
      for (let part = item.parts.length - 1; part >= 0; part--) {
        const value = item.parts[part];
        const line = value?.type === "text" ? lastLine(value.text, max) : undefined;
        if (line) return line;
      }
    }
    return undefined;
  }
}
