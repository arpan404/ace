/*
 * Files the agents changed across threads, read from the daemon in every mode: the thread list
 * names the threads, and each thread's newest page of items (`items.page`) carries the changes
 * its tool calls made, which `@ace/ui-core` groups by path the way the Changes tab does. A file
 * the agent created whole downloads as it wrote it.
 */
import type { ClientApi } from "@ace/client";
import { useSidebarIds } from "@ace/client-react";
import { threadFiles, type ChangedFile } from "@ace/ui-core";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { UnavailableError, useFakeBackend, type FakeBackend } from "@/boot/fake-backend.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";

export type { ChangedFile } from "@ace/ui-core";

/** The most recently active threads the page reads, and how many it reads at once. */
const threadLimit = 40;
const parallel = 4;
const itemsPerThread = 200;

const key = ["files", "changed"] as const;
/** Uploads land in this pseudo-thread until the transfer protocol names a destination. */
export const uploadsThread = { id: "uploads", title: "Uploaded by you" };

async function readChangedFiles(client: ClientApi, signal: AbortSignal): Promise<ChangedFile[]> {
  const lease = client.threads();
  let threads;
  try {
    const list = lease.store;
    threads = list.ids
      .flatMap((id) => {
        const thread = list.thread(id);
        return thread && thread.deletedAt === undefined ? [thread] : [];
      })
      .toSorted((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, threadLimit);
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
  return files.flat();
}

// TODO(client-gaps): files transfers. Uploads ride `files.request`'s binary channels, which
// `ClientApi` can't carry (only `downloadArtifact` over a separate authenticated socket exists
// in @ace/client), and the daemon starts its files service only with ACE_WORKSPACE_ROOT. Until
// then uploads go to the fake backend in fake mode and are unavailable against a real daemon.
async function loaded(backend: Promise<FakeBackend> | null): Promise<FakeBackend> {
  if (!backend) throw new UnavailableError("Uploads");
  return backend;
}

/** Changed files across threads, newest thread first, plus this session's fake uploads. */
export function useChangedFiles() {
  const ids = useSidebarIds();
  const backend = useFakeBackend();
  return useDaemonQuery({
    queryKey: [...key, ids],
    enabled: ids !== undefined,
    read: async (client, signal) => {
      const uploads = backend
        ? (await backend).files.filter((file) => file.threadId === uploadsThread.id)
        : [];
      return [...uploads, ...(await readChangedFiles(client, signal))];
    },
  });
}

/** Whether this daemon can take uploads (fake mode only, until the transfer protocol lands). */
export function useUploadsAvailable(): boolean {
  return useFakeBackend() !== null;
}

/** Send a local file into a project's worktree. */
export function useUploadFile() {
  const backend = useFakeBackend();
  const queries = useQueryClient();
  return useMutation({
    mutationFn: async (input: { workspaceId: string; file: File; now: number }) => {
      const fake = await loaded(backend);
      const path = `uploads/${input.file.name}`;
      const text = await input.file.text();
      fake.files = [
        {
          threadId: uploadsThread.id,
          threadTitle: uploadsThread.title,
          workspaceId: input.workspaceId,
          path,
          changes: [{ path, kind: "add", newText: text }],
          updatedAt: input.now,
          text,
        },
        ...fake.files.filter(
          (entry) => !(entry.threadId === uploadsThread.id && entry.path === path),
        ),
      ];
      return path;
    },
    onSuccess: () => queries.invalidateQueries({ queryKey: key }),
  });
}
