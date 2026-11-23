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
  ToolSurface,
  type Thread,
  type TurnStepsResponse,
} from "@ace/protocol";
import { nativeHandle } from "@ace/provider-kit/sqlite";
import type { SearchIndex } from "@ace/search";
import type { LongThreadIndex } from "../long-thread/index.ts";
import type { PayloadStore } from "../payload-store.ts";
import type { TurnStepsSource } from "../long-thread/steps.ts";

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
  const handle = nativeHandle(
    source.index.data.db as unknown as object,
  ) as unknown as NativeLongThread | undefined;
  if (!handle) throw new Error("ACE_STORE=native needs the store addon");
  return handle;
}

function readable(source: NativeSource, id: ThreadId): void {
  source.flush();
  const thread = source.getThread(id);
  if (!thread || thread.deletedAt !== undefined) throw new Error("thread_not_found");
}

function validSurface(
  surface: { kind: string; icon?: unknown },
  iconRef: string | undefined,
): { kind: string; icon?: unknown; iconRef?: string } | undefined {
  const whole = ToolSurface.safeParse(
    iconRef ? { ...surface, iconRef } : surface,
  );
  if (whole.success) return whole.data as { kind: string; icon?: unknown; iconRef?: string };
  const unresolved = ToolSurface.safeParse(surface);
  if (unresolved.success)
    return unresolved.data as { kind: string; icon?: unknown; iconRef?: string };
  const bare = ToolSurface.safeParse({ kind: surface.kind });
  return bare.success
    ? (bare.data as { kind: string; icon?: unknown; iconRef?: string })
    : undefined;
}

export function turnsPageNative(
  source: NativeSource,
  input: Omit<
    { threadId: ThreadId; before?: number; after?: number; limit?: number; requestId?: string },
    "type" | "requestId"
  > & { requestId?: string },
) {
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
    { threadId: ThreadId; turnOrdinal: number; after?: number; limit?: number; requestId?: string },
    "type" | "requestId" | "limit"
  > & { requestId?: string; limit?: number },
  cachedIcon?: TurnStepsSource["cachedIcon"],
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
  const response = JSON.parse(json) as TurnStepsResponse;
  for (const step of response.steps) {
    const surface = (step as { surface?: { kind: string; icon?: { kind: string } } }).surface;
    if (!surface) continue;
    const icon = (surface as { icon?: { kind: string } }).icon;
    const ref = icon
      ? cachedIcon?.(icon as Parameters<NonNullable<TurnStepsSource["cachedIcon"]>>[0])
      : undefined;
    const shown = validSurface(
      surface as { kind: string; icon?: unknown },
      typeof ref === "string" ? ref : undefined,
    );
    if (shown) Object.assign(step, { surface: shown });
    else delete (step as { surface?: unknown }).surface;
  }
  return response;
}

export function threadSearchNative(
  source: NativeSource,
  input: Omit<
    {
      threadId: ThreadId;
      text: string;
      scope?: "thread" | "tree";
      filter?: "messages" | "tool_output" | "commands" | "files" | "errors";
      limit?: number;
      cursor?: string;
      requestId?: string;
    },
    "type" | "requestId"
  > & { requestId?: string },
  authorize: (id: ThreadId) => boolean = () => true,
) {
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
    { threadId: ThreadId; sinceSeq?: number; sinceTime?: number; requestId?: string },
    "type" | "requestId"
  > & { requestId?: string },
  authorize: (id: ThreadId) => boolean = () => true,
) {
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
  return JSON.parse(json);
}
