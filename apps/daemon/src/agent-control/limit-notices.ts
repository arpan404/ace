import type { DelegationRecord, McpAttribution, ThreadId } from "@ace/protocol";
import type { Store } from "../store.ts";
import type { DelegationJournal } from "./journal.ts";
import { controlCommandId } from "./command-id.ts";
import { limitNoticeText, usageLimitHold } from "./limit-hold.ts";

export interface LimitNoticeDependencies {
  store: Store;
  journal: DelegationJournal;
  now(): number;
  /** A resume of the thread is in flight, so its hold is ending. */
  resuming(id: ThreadId): boolean;
  /** The thread's root turn ended on a usage limit and nothing runs or retries. */
  endedOnLimit(id: ThreadId): boolean;
  /** A live wait of `parent` watches `child`, so the wait reports the hold. */
  watching(child: ThreadId, parent: ThreadId): boolean;
  /** The notice `id` was already accepted, as before a crash that lost its record. */
  sent(id: string): boolean;
  /** Sends `text` about `child` to `target` as a result reaches it; throws when refused. */
  send(target: ThreadId, child: ThreadId, id: string, text: string): void;
  /** Children are waiting to be tried again: the owner's timer should run. */
  retrying(): void;
  closed(): boolean;
  report(error: unknown): void;
}

/**
 * A running delegated child whose turn ended on its usage limit does nothing until the limit
 * resets, so it never settles and its parent would wait on it for hours. The parent hears it
 * once per hold, the way it hears results, unless its own live wait on the child reports it.
 * What it was told is kept on the edge, so a restart neither repeats nor loses it.
 */
export class LimitNotices {
  private deps: LimitNoticeDependencies;
  /** Children whose notice could not be sent yet; `retry` tries them again. */
  private pending = new Set<ThreadId>();
  constructor(deps: LimitNoticeDependencies) {
    this.deps = deps;
  }
  get retrying(): boolean {
    return this.pending.size > 0;
  }
  /** Re-reads the child's hold and tells its parent when it newly holds. */
  check(edge: DelegationRecord) {
    this.pending.delete(edge.childId);
    const { store } = this.deps;
    const thread = store.getThread(edge.childId);
    if (this.deps.closed() || !thread || edge.phase !== "running") return;
    if (edge.resultDelivery === "owner") return;
    const hold = usageLimitHold(thread, edge, {
      resuming: this.deps.resuming(edge.childId),
      endedOnLimit: () => this.deps.endedOnLimit(edge.childId),
    });
    const told = edge.limitNotice;
    if (!hold) {
      if (told?.held) this.save(edge, { ...told, held: false });
      return;
    }
    if (told?.held || this.deps.watching(edge.childId, edge.parentId)) return;
    if (!store.getThread(edge.parentId)) return;
    const count = (told?.count ?? 0) + 1;
    const id = controlCommandId(edge.parentId, `${edge.childId}:${count}`, "limit_notice");
    const text = limitNoticeText(hold, edge.request.role, edge.childId);
    try {
      // Sent and recorded together: a crash or a refused send leaves it to be sent again.
      store.atomic(() => {
        if (!this.deps.sent(id))
          this.deps.send(
            edge.parentId,
            edge.childId,
            id,
            `[ace-origin:delegation.limit_notice:${id}]\n${text}`,
          );
        this.save(edge, { count, held: true, at: this.deps.now() });
      });
    } catch (error) {
      edge.limitNotice = told;
      this.pending.add(edge.childId);
      this.deps.retrying();
      this.deps.report(error);
    }
  }
  /** Checks each of these children again: a wait on them ended, or a send was refused. */
  recheck(ids: Iterable<ThreadId>) {
    // A copy: checking a child takes it out of `pending`, which may be what is passed here.
    for (const id of Array.from(ids)) {
      const edge = this.deps.journal.get(id);
      if (edge) this.check(edge);
      else this.pending.delete(id);
    }
  }
  retry() {
    this.recheck(this.pending);
  }
  /** The parent's own wait reported the hold: it is told, and no message repeats it. */
  delivered(caller: McpAttribution, child: ThreadId) {
    const edge = this.deps.journal.get(child);
    if (!edge || edge.parentId !== caller.threadId || edge.limitNotice?.held) return;
    const count = (edge.limitNotice?.count ?? 0) + 1;
    this.save(edge, { count, held: true, at: this.deps.now() });
  }
  private save(edge: DelegationRecord, notice: DelegationRecord["limitNotice"]) {
    edge.limitNotice = notice;
    this.deps.store.atomic(() => this.deps.journal.save(edge));
  }
}
