import {
  TurnsPageRequest,
  ItemsWindowRequest,
  ItemsWindowResponse,
  ThreadSearchRequest,
  ThreadCatchUpRequest,
  TurnStepsRequest,
  ThreadId,
  type Thread,
  type DeviceId,
  type TurnStepsRequest as StepsQuery,
  type TurnsPageRequest as TurnsQuery,
  type ItemsWindowRequest as WindowQuery,
  type ThreadSearchRequest as ThreadSearchQuery,
  type ThreadCatchUpRequest as CatchUpQuery,
} from "@ace/protocol";
import type { SearchIndex } from "@ace/search";
import type { LongThreadIndex } from "./index.ts";
import type { PayloadStore } from "../payload-store.ts";
import { readTurnSteps, stepSurface, type TurnStepsSource } from "./steps.ts";
interface NavigationSource {
  index: LongThreadIndex;
  payloads: PayloadStore;
  search: SearchIndex;
  getThread(id: ThreadId): Thread | undefined;
  flush(): void;
  headSeq(): number;
  now(): number;
  atomic(run: () => void): void;
}
/** Request validation, authorization and indexed navigation through a long thread. */
export class LongThreadQueries {
  private readonly source: NavigationSource;
  /** The site each agent was on before a step, as turn.steps and icons work it out. */
  private readonly stepSites = new Map<string, string | null>();
  constructor(source: NavigationSource) {
    this.source = source;
  }
  private readableThread(id: ThreadId): Thread {
    this.source.flush();
    const thread = this.source.getThread(id);
    if (!thread || thread.deletedAt !== undefined) throw new Error("thread_not_found");
    return thread;
  }
  turnsPage(input: Omit<TurnsQuery, "type" | "requestId"> & { requestId?: string }) {
    const query = TurnsPageRequest.parse({ type: "turns.page", requestId: "turns", ...input });
    this.readableThread(query.threadId);
    return this.source.index.reader.page(query, this.source.headSeq());
  }
  turnSteps(
    input: Omit<StepsQuery, "type" | "requestId" | "limit"> & {
      requestId?: string;
      limit?: number;
    },
    cachedIcon?: TurnStepsSource["cachedIcon"],
  ) {
    const query = TurnStepsRequest.parse({ type: "turn.steps", requestId: "steps", ...input });
    this.readableThread(query.threadId);
    return readTurnSteps(
      {
        data: this.source.index.data,
        item: (threadId, itemId) => this.source.payloads.stepItem(threadId, itemId),
        sites: this.stepSites,
        cachedIcon,
      },
      query,
      this.source.headSeq(),
    );
  }
  stepSurface(threadId: ThreadId, itemId: string) {
    this.readableThread(threadId);
    return stepSurface(
      {
        data: this.source.index.data,
        item: (thread, id) => this.source.payloads.stepItem(thread, id),
        sites: this.stepSites,
      },
      threadId,
      itemId,
    );
  }
  itemsWindow(input: Omit<WindowQuery, "type" | "requestId"> & { requestId?: string }) {
    const query = ItemsWindowRequest.parse({ type: "items.window", requestId: "window", ...input });
    this.readableThread(query.threadId);
    let target = query.aroundSeq;
    if (query.itemId !== undefined) {
      target = this.source.payloads.itemCreatedSeq(query.threadId, query.itemId);
      if (target === undefined)
        return ItemsWindowResponse.parse({
          type: "items.window",
          requestId: query.requestId,
          threadId: query.threadId,
          seq: this.source.headSeq(),
          targetSeq: null,
          items: [],
          itemSeqs: {},
          itemsBefore: null,
          itemsAfter: null,
        });
    }
    if (query.turnOrdinal !== undefined) {
      const row = this.source.index.data
        .sql(
          "SELECT MIN(i.created_seq) AS seq FROM long_items i JOIN item_heads h ON h.id=i.item_id AND h.thread_id=i.thread_id WHERE i.thread_id=? AND i.ordinal=?",
        )
        .get(query.threadId, query.turnOrdinal);
      if (row?.seq == null) throw new Error("turn_target_unavailable");
      target = Number(row.seq);
    }
    const window = this.source.payloads.window(
      query.threadId,
      target ?? 0,
      query.before,
      query.after,
      1024 * 1024,
    );
    return ItemsWindowResponse.parse({
      type: "items.window",
      requestId: query.requestId,
      seq: this.source.headSeq(),
      ...(query.wholeTurns ? this.wholeTurns(window) : window),
    });
  }
  /**
   * A window whose older items come in whole turns: it starts where the oldest turn that
   * starts inside its older part starts, so no turn is split at its older edge. When one turn
   * fills the whole older part, the budgets cut it and the cursor still says more is older.
   * The cut keeps at least one older item, so every read before the thread's start moves the
   * cursor, whatever its turns start with (an ask, or a run the agent started itself).
   */
  private wholeTurns<
    W extends {
      threadId: ThreadId;
      targetSeq: number | null;
      items: { id: string }[];
      itemSeqs: Record<string, number>;
      itemsBefore: number | null;
    },
  >(window: W): W {
    const first = window.items[0];
    const firstSeq = first ? window.itemSeqs[first.id] : undefined;
    if (window.itemsBefore === null || firstSeq === undefined || window.targetSeq === null)
      return window;
    const data = this.source.index.data;
    // The first item already starts a turn when its turn began after the item before it (a
    // turn may begin with a run event rather than an item).
    const own = data
      .sql(
        "SELECT start_seq FROM long_turns WHERE thread_id=? AND start_seq<=? ORDER BY start_seq DESC LIMIT 1",
      )
      .get(window.threadId, firstSeq);
    const previous = data
      .sql(
        "SELECT created_seq FROM item_heads WHERE thread_id=? AND created_seq<? ORDER BY created_seq DESC LIMIT 1",
      )
      .get(window.threadId, firstSeq);
    if (own?.start_seq != null && Number(own.start_seq) > Number(previous?.created_seq ?? 0))
      return window;
    // The cut must keep at least one older item: a turn starting after the newest of them is
    // the target's own (one that began with a run event, before its first item), and cutting
    // there would return only the target with an unmoved cursor, so paging older never ends.
    let newestOlder: number | undefined;
    for (const item of window.items) {
      const seq = window.itemSeqs[item.id];
      if (seq !== undefined && seq < window.targetSeq) newestOlder = seq;
    }
    if (newestOlder === undefined) return window;
    const row = data
      .sql(
        "SELECT start_seq FROM long_turns WHERE thread_id=? AND start_seq>? AND start_seq<=? ORDER BY start_seq LIMIT 1",
      )
      .get(window.threadId, firstSeq, newestOlder);
    const start = row?.start_seq == null ? undefined : Number(row.start_seq);
    if (start === undefined) return window;
    const items = window.items.filter((item) => (window.itemSeqs[item.id] ?? 0) >= start);
    const kept = items[0];
    return {
      ...window,
      items,
      itemSeqs: Object.fromEntries(items.map((item) => [item.id, window.itemSeqs[item.id] ?? 0])),
      itemsBefore: kept ? (window.itemSeqs[kept.id] ?? start) : start,
    };
  }
  threadSearch(
    input: Omit<ThreadSearchQuery, "type" | "requestId"> & { requestId?: string },
    authorize: (id: ThreadId) => boolean = () => true,
  ) {
    const query = ThreadSearchRequest.parse({
      type: "thread.search",
      requestId: "search",
      ...input,
    });
    this.readableThread(query.threadId);
    const threads =
      query.scope === "tree"
        ? this.source.index.reader.descendantThreads(query.threadId)
        : [query.threadId];
    if (threads.some((id) => !authorize(ThreadId.parse(id)))) throw new Error("forbidden");
    const response = this.source.search.threadQuery(query, {
      headSeq: this.source.headSeq(),
      threadIds: threads,
      turnOrdinalForItem: (thread, item) => this.source.index.reader.ordinal(thread, item),
    });
    const indexedSeq = Math.min(response.indexedSeq, this.source.index.data.indexedSeq());
    return { ...response, indexedSeq, ready: response.ready && indexedSeq >= response.headSeq };
  }
  threadCatchUp(
    input: Omit<CatchUpQuery, "type" | "requestId"> & { requestId?: string },
    authorize: (id: ThreadId) => boolean = () => true,
  ) {
    const query = ThreadCatchUpRequest.parse({
      type: "thread.catchUp",
      requestId: "catch-up",
      ...input,
    });
    this.readableThread(query.threadId);
    const family = this.source.index.reader.descendantThreads(query.threadId);
    if (family.some((id) => !authorize(ThreadId.parse(id)))) throw new Error("forbidden");
    return this.source.index.reader.catchUp(query, this.source.headSeq(), family);
  }
  threadReadState(threadId: ThreadId, deviceId: DeviceId, requestId = "read-state") {
    this.readableThread(threadId);
    return this.source.index.reader.readState(threadId, deviceId, requestId);
  }
  markThreadRead(threadId: ThreadId, deviceId: DeviceId, lastSeenSeq: number): void {
    this.readableThread(threadId);
    this.source.atomic(() =>
      this.source.index.reader.markRead(
        threadId,
        deviceId,
        lastSeenSeq,
        this.source.headSeq(),
        this.source.now(),
      ),
    );
  }
}
