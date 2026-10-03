// TODO(train-2): wire to protocol when merged
/*
 * Files changed across threads, plus file transfer (#44: files.request download/upload).
 * Neither is on the wire on this branch, so both use the fake backend in fake mode.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { UnavailableError, useFakeBackend, type FakeBackend } from "@/boot/fake-backend.ts";

export interface ChangedFile {
  threadId: string;
  threadTitle: string;
  workspaceId: string;
  path: string;
  change: "modified" | "added" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  updatedAt: number;
}

async function loaded(backend: Promise<FakeBackend> | null): Promise<FakeBackend> {
  if (!backend) throw new UnavailableError("Files");
  return backend;
}

const key = ["files", "changed"] as const;
/** Uploads land in this pseudo-thread until the transfer protocol names a destination. */
export const uploadsThread = { id: "uploads", title: "Uploaded by you" };

export function useChangedFiles() {
  const backend = useFakeBackend();
  return useQuery({
    queryKey: key,
    queryFn: async (): Promise<ChangedFile[]> =>
      (await loaded(backend)).files.map(({ text: _text, ...file }) => file),
  });
}

/** Read a file's current contents for a download. */
export function useDownloadFile() {
  const backend = useFakeBackend();
  return useMutation({
    mutationFn: async (file: ChangedFile): Promise<{ name: string; text: string }> => {
      const found = (await loaded(backend)).files.find(
        (entry) => entry.threadId === file.threadId && entry.path === file.path,
      );
      if (!found || found.change === "deleted") throw new Error(`${file.path} no longer exists.`);
      return { name: found.path.split("/").at(-1) ?? found.path, text: found.text };
    },
  });
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
          change: "added",
          additions: text ? text.split("\n").length : 0,
          deletions: 0,
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
