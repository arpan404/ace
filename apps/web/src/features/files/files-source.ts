/*
 * Files the agents changed across threads, read from the daemon in every mode: the thread list
 * names the threads, and each thread's newest page of items (`items.page`) carries the changes
 * its tool calls made, which `@ace/ui-core` groups by path the way the Changes tab does. Any file
 * that still exists downloads from the thread's checkout (`ClientApi.downloadFile`).
 */
import type { ClientApi } from "@ace/client";
import { useClient, useSidebarLoaded } from "@ace/client-react";
import { ThreadId } from "@ace/protocol";
import { threadFiles, type ChangedFile } from "@ace/ui-core";
import { useDaemonQuery } from "@/lib/daemon-query.ts";

export type { ChangedFile } from "@ace/ui-core";

/** The most recently active threads the page reads, and how many it reads at once. */
export const threadLimit = 40;
const parallel = 4;
const itemsPerThread = 200;

const key = ["files", "changed"] as const;
export interface ChangedFiles {
  files: ChangedFile[];
  /** More threads exist than the page reads (`threadLimit`). */
  capped: boolean;
}

/** How often the page reads again while it is open (and on focus or reopen). */
const refreshMs = 30_000;

/**
 * The `limit` most recently updated threads, newest first, in one pass over the list: a short
 * sorted window instead of sorting the whole history.
 */
function recent<T extends { updatedAt: number }>(threads: Iterable<T>, limit: number): T[] {
  const top: T[] = [];
  for (const thread of threads) {
    if (top.length === limit && (top.at(-1)?.updatedAt ?? 0) >= thread.updatedAt) continue;
    let at = top.length;
    while (at > 0 && (top[at - 1]?.updatedAt ?? 0) < thread.updatedAt) at--;
    top.splice(at, 0, thread);
    if (top.length > limit) top.pop();
  }
  return top;
}

/*
 * Every read takes the newest threads' items as they are now. Nothing is kept between reads:
 * a thread's list entry doesn't change when its tool calls do (its `updatedAt` can stay put),
 * so a per-thread cache keyed on it would go stale, and it would only grow with history.
 */
async function readChangedFiles(client: ClientApi, signal: AbortSignal): Promise<ChangedFiles> {
  const lease = client.threads();
  let threads;
  let total = 0;
  try {
    const list = lease.store;
    const live = list.ids.flatMap((id) => {
      const thread = list.thread(id);
      return thread && thread.deletedAt === undefined ? [thread] : [];
    });
    total = live.length;
    threads = recent(live, threadLimit);
  } finally {
    lease.release();
  }
  const files: ChangedFile[][] = [];
  for (let at = 0; at < threads.length; at += parallel) {
    const batch = threads.slice(at, at + parallel);
    files.push(
      ...(await Promise.all(
        batch.map(async (thread) => {
          const page = await client.itemsPage(
            { threadId: thread.id, limit: itemsPerThread },
            { signal },
          );
          return threadFiles(thread, page.items);
        }),
      )),
    );
  }
  return { files: files.flat(), capped: total > threadLimit };
}

/**
 * Changed files across threads, newest thread first. One query for the page: it reads again
 * every 30s while open, on focus and on reopen, and the list on screen stays meanwhile (a
 * spinner, never the skeleton again).
 */
export function useChangedFiles() {
  const loaded = useSidebarLoaded();
  return useDaemonQuery({
    queryKey: key,
    enabled: loaded,
    read: readChangedFiles,
    refetchInterval: refreshMs,
    staleTime: 0,
  });
}

/** Downloads above this go through the thread's Files panel, which streams to disk. */
export const downloadLimit = 64 * 1024 * 1024;

export class DownloadTooLarge extends Error {
  constructor() {
    super("Files over 64 MB download from the thread's Files panel.");
    this.name = "DownloadTooLarge";
  }
}

/** The bytes of a file in a thread's checkout, as it is now. */
export function useDownloadFile() {
  const client = useClient();
  return async (file: Pick<ChangedFile, "threadId" | "path">): Promise<Blob> => {
    const parts: Uint8Array<ArrayBuffer>[] = [];
    let size = 0;
    for await (const chunk of client.downloadFile({
      threadId: ThreadId.parse(file.threadId),
      op: "download",
      path: file.path,
      offset: 0,
    })) {
      size += chunk.length;
      if (size > downloadLimit) throw new DownloadTooLarge();
      parts.push(new Uint8Array(chunk));
    }
    return new Blob(parts);
  };
}
