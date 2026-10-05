/*
 * Files the agents changed across threads, read from the daemon in every mode: the thread list
 * names the threads, and each thread's newest page of items (`items.page`) carries the changes
 * its tool calls made, which `@ace/ui-core` groups by path the way the Changes tab does. Any file
 * that still exists downloads from the thread's checkout (`ClientApi.downloadFile`).
 */
import type { ClientApi } from "@ace/client";
import { useClient, useSidebarAll } from "@ace/client-react";
import { ThreadId } from "@ace/protocol";
import { threadFiles, type ChangedFile } from "@ace/ui-core";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { useDaemonQuery } from "@/lib/daemon-query.ts";

export type { ChangedFile } from "@ace/ui-core";

/** The most recently active threads the page reads, and how many it reads at once. */
export const threadLimit = 40;
const parallel = 4;
const itemsPerThread = 200;

const key = ["files", "changed"] as const;

interface ThreadStamp {
  id: string;
  updatedAt: number;
}

/** What one thread contributed, as of its `updatedAt`, so an unchanged thread isn't read again. */
const readByClient = new WeakMap<
  ClientApi,
  Map<string, { updatedAt: number; files: ChangedFile[] }>
>();

export interface ChangedFiles {
  files: ChangedFile[];
  /** More threads exist than the page reads (`threadLimit`). */
  capped: boolean;
}

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
    threads = live.toSorted((a, b) => b.updatedAt - a.updatedAt).slice(0, threadLimit);
  } finally {
    lease.release();
  }
  let cache = readByClient.get(client);
  if (!cache) {
    cache = new Map();
    readByClient.set(client, cache);
  }
  const known = cache;
  const files: ChangedFile[][] = [];
  for (let at = 0; at < threads.length; at += parallel) {
    const batch = threads.slice(at, at + parallel);
    files.push(
      ...(await Promise.all(
        batch.map(async (thread) => {
          const kept = known.get(thread.id);
          if (kept && kept.updatedAt === thread.updatedAt) return kept.files;
          const page = await client.itemsPage(
            { threadId: thread.id, limit: itemsPerThread },
            { signal },
          );
          const found = threadFiles(thread, page.items);
          known.set(thread.id, { updatedAt: thread.updatedAt, files: found });
          return found;
        }),
      )),
    );
  }
  return { files: files.flat(), capped: total > threadLimit };
}

/** "id:updatedAt" of the threads the page reads: it changes exactly when a re-read is due. */
function stampsOf(reader: {
  ids: readonly string[];
  thread(id: string): { updatedAt: number; deletedAt?: number | undefined } | undefined;
}): string {
  const stamps: ThreadStamp[] = [];
  for (const id of reader.ids) {
    const thread = reader.thread(id);
    if (thread && thread.deletedAt === undefined) stamps.push({ id, updatedAt: thread.updatedAt });
  }
  return stamps
    .toSorted((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, threadLimit)
    .map((stamp) => `${stamp.id}:${stamp.updatedAt}`)
    .join(",");
}

/**
 * Changed files across threads, newest thread first. One query for the page: when a thread it
 * reads changes, only that thread is read again, and the list on screen stays meanwhile.
 */
export function useChangedFiles() {
  const stamps = useSidebarAll(stampsOf);
  const queries = useQueryClient();
  const seen = useRef(stamps);
  useEffect(() => {
    if (stamps === undefined || seen.current === stamps) return;
    const first = seen.current === undefined;
    seen.current = stamps;
    if (!first) void queries.invalidateQueries({ queryKey: key });
  }, [stamps, queries]);
  return useDaemonQuery({ queryKey: key, enabled: stamps !== undefined, read: readChangedFiles });
}

/** The bytes of a file in a thread's checkout, as it is now. */
export function useDownloadFile() {
  const client = useClient();
  return async (file: Pick<ChangedFile, "threadId" | "path">): Promise<Blob> => {
    const parts: Uint8Array<ArrayBuffer>[] = [];
    for await (const chunk of client.downloadFile({
      threadId: ThreadId.parse(file.threadId),
      op: "download",
      path: file.path,
      offset: 0,
    }))
      parts.push(new Uint8Array(chunk));
    return new Blob(parts);
  };
}
