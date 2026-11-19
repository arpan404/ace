import { useCallback, useMemo } from "react";
import { useQueries } from "@tanstack/react-query";
import { useClient, useConnectionState } from "@ace/client-react";
import type { ClientApi } from "@ace/client";
import type { ForgeFile, ForgeImageType, ForgeRepository } from "@ace/protocol";
import { readForge } from "@/lib/forge-read.ts";
import { hostedImageType } from "@ace/ui-core";

/** One side of a changed file, read whole. */
export type HostedSide =
  | { kind: "text"; text: string; size: number }
  | { kind: "image"; url: string; size: number }
  | { kind: "binary"; size: number }
  | { kind: "large"; size: number }
  | { kind: "missing" };

/** Both sides of a file GitHub withheld the patch of, as far as they have been read. */
export type FileSides =
  | { state: "pending" }
  | { state: "failed"; error: Error }
  | { state: "ready"; base: HostedSide; head: HostedSide };

interface SideRead {
  sha: string;
  path: string;
  image: ForgeImageType | undefined;
}

/** The two reads a file needs; a side the change has no file on reads as missing. */
function sideReads(file: ForgeFile, range: { baseSha: string; headSha: string }) {
  const image = hostedImageType(file.path);
  return {
    path: file.path,
    base:
      file.status === "added"
        ? undefined
        : { sha: range.baseSha, path: file.previousPath ?? file.path, image },
    head: file.status === "removed" ? undefined : { sha: range.headSha, path: file.path, image },
  };
}

async function readSide(
  client: ClientApi,
  scope: { workspaceId: string; repository: ForgeRepository },
  side: SideRead,
  signal: AbortSignal,
): Promise<HostedSide> {
  let text = "";
  for (let page = 1; ;) {
    const result = await readForge(
      client,
      {
        op: "forge.file.content",
        ...scope,
        sha: side.sha,
        path: side.path,
        page,
        ...(side.image ? { image: side.image } : {}),
      },
      signal,
    );
    if (result.resource !== "fileContent") throw new Error("No file content in the response.");
    const value = result.value;
    if (value.kind === "image")
      return { kind: "image", url: `data:${value.type};base64,${value.data}`, size: value.size };
    if (value.kind !== "text") return value;
    text += value.text;
    if (!value.nextPage) return { kind: "text", text, size: value.size };
    page = value.nextPage;
  }
}

const missing: HostedSide = { kind: "missing" };

/**
 * Both sides of each wanted file, read from the daemon in pages and kept by commit and path
 * (content at a commit never changes). A read that failed stays failed until `retry`.
 */
export function usePrFileSides(props: {
  workspaceId: string;
  repository: ForgeRepository;
  range: { baseSha: string; headSha: string } | undefined;
  files: readonly ForgeFile[];
  wanted: ReadonlySet<string>;
}) {
  const client = useClient();
  const ready = useConnectionState() === "ready";
  const { workspaceId, repository, range, files, wanted } = props;
  const reads = useMemo(
    () =>
      range
        ? files.filter((file) => wanted.has(file.path)).map((file) => sideReads(file, range))
        : [],
    [files, wanted, range],
  );
  const queries = reads.flatMap((read) =>
    [read.base, read.head].flatMap((side) =>
      side
        ? [
            {
              queryKey: [
                "forge",
                workspaceId,
                "file-content",
                side.sha,
                side.path,
                side.image ?? "text",
              ],
              meta: { daemonClient: client },
              enabled: ready,
              retry: false,
              staleTime: Number.POSITIVE_INFINITY,
              queryFn: ({ signal }: { signal: AbortSignal }) =>
                readSide(client, { workspaceId, repository }, side, signal),
            },
          ]
        : [],
    ),
  );
  // Combined once per change of any read, so the sides (and the diffs keyed on them) stay put.
  const combine = useCallback(
    (
      results: readonly {
        data?: HostedSide | undefined;
        error: Error | null;
        refetch(): unknown;
      }[],
    ) => {
      const sides = new Map<string, FileSides>();
      const failed: (() => unknown)[] = [];
      let index = 0;
      for (const read of reads) {
        const [base, head] = [read.base, read.head].map((side) => {
          if (!side) return { data: missing, error: null };
          const result = results[index++];
          if (result?.error) failed.push(result.refetch);
          return { data: result?.data, error: result?.error ?? null };
        });
        const error = base?.error ?? head?.error;
        sides.set(
          read.path,
          error
            ? { state: "failed", error }
            : base?.data && head?.data
              ? { state: "ready", base: base.data, head: head.data }
              : { state: "pending" },
        );
      }
      return { sides, failed };
    },
    [reads],
  );
  const { sides, failed } = useQueries({ queries, combine });
  const retry = useCallback(() => {
    for (const refetch of failed) void refetch();
  }, [failed]);
  return { sides, retry };
}

/** The texts to diff for each file whose sides both read as text (or one side is missing). */
export function sideTexts(
  sides: ReadonlyMap<string, FileSides>,
): Map<string, { oldText: string | null; newText: string | null }> {
  const texts = new Map<string, { oldText: string | null; newText: string | null }>();
  for (const [path, read] of sides) {
    if (read.state !== "ready") continue;
    const { base, head } = read;
    const text = (side: HostedSide) =>
      side.kind === "text" ? side.text : side.kind === "missing" ? null : undefined;
    const oldText = text(base);
    const newText = text(head);
    if (oldText === undefined || newText === undefined || (oldText ?? newText) === null) continue;
    texts.set(path, { oldText, newText });
  }
  return texts;
}
