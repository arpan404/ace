// SPDX-License-Identifier: Apache-2.0
//! Native long-thread reads (phase 2). The single `if (nativeReads("long"))` line at the
//! top of each `LongThreadQueries` loader lands here, which parses with the protocol schemas,
//! checks the thread and authorization in TypeScript, then reads on the native connection.

import {
  ThreadCatchUpRequest,
  ThreadId,
  ThreadSearchRequest,
  TurnStepsRequest,
  TurnsPageRequest,
  type Thread,
  type ThreadCatchUpResponse,
  type ThreadSearchResponse,
  type TurnStepsResponse,
  type TurnsPageResponse,
} from "@ace/protocol";
import { nativeHandle } from "@ace/provider-kit/sqlite";
import type { SearchIndex } from "@ace/search";
import type { LongThreadIndex } from "../long-thread/index.ts";
import type { PayloadStore } from "../payload-store.ts";
import { shapeTurnSteps, type TurnStepRow, type TurnStepsSource } from "../long-thread/steps.ts";

interface NativeSource {
  index: LongThreadIndex;
  payloads: PayloadStore;
  search: SearchIndex;
  getThread(id: ThreadId): Thread | undefined;
  flush(): void;
  headSeq(): number;
  now(): number;
  atomic(run: () => void): void;
}

interface NativeLongThread {
  longTurnsPage(
    threadId: string,
    before: number | undefined,
    after: number | undefined,
    limit: number,
    requestId: string,
    headSeq: number,
  ): string;
  longTurnSteps(
    threadId: string,
    turnOrdinal: number,
    after: number | undefined,
    limit: number,
    requestId: string,
    headSeq: number,
  ): string;
  longThreadSearch(
    threadId: string,
    requestId: string,
    text: string,
    scope: string,
    filter: string | undefined,
    limit: number,
    cursor: string | undefined,
    threadIds: string[],
    headSeq: number,
  ): string;
  longThreadCatchUp(
    threadId: string,
    requestId: string,
    sinceSeq: number | undefined,
    sinceTime: number | undefined,
    family: string[],
    headSeq: number,
  ): string;
}

function binding(source: NativeSource): NativeLongThread {
  const handle = nativeHandle(source.index.data.db as unknown as object) as unknown as
    | NativeLongThread
    | undefined;
  if (!handle) throw new Error("ACE_STORE=native needs the store addon");
  return handle;
}

function readable(source: NativeSource, id: ThreadId): void {
  source.flush();
  const thread = source.getThread(id);
  if (!thread || thread.deletedAt !== undefined) throw new Error("thread_not_found");
}

export function turnsPageNative(
  source: NativeSource,
  input: Omit<
    {
      threadId: ThreadId;
      before?: number | undefined;
      after?: number | undefined;
      limit?: number | undefined;
      requestId?: string | undefined;
    },
    "type" | "requestId"
  > & { requestId?: string | undefined },
): TurnsPageResponse {
  const query = TurnsPageRequest.parse({ type: "turns.page", requestId: "turns", ...input });
  readable(source, query.threadId);
  const json = binding(source).longTurnsPage(
    query.threadId,
    query.before,
    query.after,
    query.limit,
    query.requestId,
    source.headSeq(),
  );
  return JSON.parse(json);
}

export function turnStepsNative(
  source: NativeSource,
  input: Omit<
    {
      threadId: ThreadId;
      turnOrdinal: number;
      after?: number | undefined;
      limit?: number | undefined;
      requestId?: string | undefined;
    },
    "type" | "requestId" | "limit"
  > & { requestId?: string | undefined; limit?: number | undefined },
  cachedIcon?: TurnStepsSource["cachedIcon"],
  sites?: Map<string, string | null>,
): TurnStepsResponse {
  const query = TurnStepsRequest.parse({ type: "turn.steps", requestId: "steps", ...input });
  readable(source, query.threadId);
  const json = binding(source).longTurnSteps(
    query.threadId,
    query.turnOrdinal,
    query.after,
    query.limit,
    query.requestId,
    source.headSeq(),
  );
  // Rust fetches the range rows; TypeScript shapes them with the existing
  // item, trust and tail code, so streaming previews, the byte budget and
  // in-memory trust match the legacy path exactly. The site cache is the
  // loader's own instance, shared with `stepSurface`, never a global.
  const fetched = JSON.parse(json) as { end_seq: number; rows: TurnStepRow[] };
  return shapeTurnSteps(
    {
      data: source.index.data,
      item: (threadId, itemId) => source.payloads.stepItem(threadId, itemId),
      sites: sites ?? new Map(),
      cachedIcon,
    },
    query,
    source.headSeq(),
    Number(fetched.end_seq),
    fetched.rows.map((row) => ({
      item_id: String(row.item_id),
      created_seq: Number(row.created_seq),
    })),
  );
}

export function threadSearchNative(
  source: NativeSource,
  input: Omit<
    {
      threadId: ThreadId;
      text: string;
      scope?: "thread" | "tree" | undefined;
      filter?: "messages" | "tool_output" | "commands" | "files" | "errors" | undefined;
      limit?: number | undefined;
      cursor?: string | undefined;
      requestId?: string | undefined;
    },
    "type" | "requestId"
  > & { requestId?: string | undefined },
  authorize: (id: ThreadId) => boolean = () => true,
): ThreadSearchResponse {
  const query = ThreadSearchRequest.parse({
    type: "thread.search",
    requestId: "search",
    ...input,
  });
  readable(source, query.threadId);
  const threads =
    query.scope === "tree"
      ? source.index.reader.descendantThreads(query.threadId)
      : [query.threadId];
  if (threads.some((id) => !authorize(ThreadId.parse(id)))) throw new Error("forbidden");
  const json = binding(source).longThreadSearch(
    query.threadId,
    query.requestId,
    query.text,
    query.scope,
    query.filter,
    query.limit,
    query.cursor,
    threads,
    source.headSeq(),
  );
  return JSON.parse(json);
}

export function threadCatchUpNative(
  source: NativeSource,
  input: Omit<
    {
      threadId: ThreadId;
      sinceSeq?: number | undefined;
      sinceTime?: number | undefined;
      requestId?: string | undefined;
    },
    "type" | "requestId"
  > & { requestId?: string | undefined },
  authorize: (id: ThreadId) => boolean = () => true,
): ThreadCatchUpResponse {
  const query = ThreadCatchUpRequest.parse({
    type: "thread.catchUp",
    requestId: "catch-up",
    ...input,
  });
  readable(source, query.threadId);
  const family = source.index.reader.descendantThreads(query.threadId);
  if (family.some((id) => !authorize(ThreadId.parse(id)))) throw new Error("forbidden");
  const json = binding(source).longThreadCatchUp(
    query.threadId,
    query.requestId,
    query.sinceSeq,
    query.sinceTime,
    family,
    source.headSeq(),
  );
  const response = JSON.parse(json);
  // The family merge sorts files with `localeCompare`, as `@ace/projection`
  // does; Rust keeps first-seen order so the shell's collation is exact.
  if (Array.isArray(response?.digest?.files)) {
    response.digest.files = [...response.digest.files].toSorted(
      (left: { path: string }, right: { path: string }) => left.path.localeCompare(right.path),
    );
  }
  return response;
}
