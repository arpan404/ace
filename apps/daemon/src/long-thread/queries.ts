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
    return ItemsWindowResponse.parse({
      type: "items.window",
      requestId: query.requestId,
      seq: this.source.headSeq(),
      ...this.source.payloads.window(
        query.threadId,
        target ?? 0,
        query.before,
        query.after,
        1024 * 1024,
      ),
    });
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
