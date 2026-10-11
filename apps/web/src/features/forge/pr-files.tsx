import { useState } from "react";
import type { ForgePrDetail, ForgeRepository } from "@ace/protocol";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { Button } from "@/components/ui/button.tsx";
import { DiffStat } from "@/components/diff-stat.tsx";
import { readForge } from "./source.ts";
import { QueryState } from "./query-state.tsx";

export function PrFiles(props: {
  workspaceId: string;
  repository: ForgeRepository;
  detail: ForgePrDetail;
  commit?: string;
}) {
  const [page, setPage] = useState(1);
  const ref = props.detail.status.ref;
  const query = useDaemonQuery({
    queryKey: [
      "forge",
      props.workspaceId,
      ref,
      "files",
      props.detail.baseSha,
      props.detail.status.headSha,
      props.commit,
      page,
    ],
    retry: false,
    read: async (client, signal) => {
      const result = await readForge(
        client,
        {
          op: "forge.pr.files",
          workspaceId: props.workspaceId,
          repository: props.repository,
          number: ref.number,
          headSha: props.detail.status.headSha,
          baseSha: props.detail.baseSha,
          page,
          ...(props.commit ? { commit: props.commit } : {}),
        },
        signal,
      );
      if (result.resource !== "prFiles") throw new Error("No changed-file response.");
      return result.value;
    },
  });
  return (
    <section aria-label="Hosted PR diff" className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {props.commit
          ? "Hosted commit diff against its first parent."
          : "Hosted PR diff from GitHub's base to the PR head."}{" "}
        Local uncommitted changes are in the task's Changes panel.
      </p>
      <QueryState query={query} />
      {query.data && (
        <>
          <p className="break-all font-mono text-xs">
            {query.data.baseSha} → {query.data.headSha}
          </p>
          {query.data.truncated && (
            <p role="status">
              Some patches are omitted or truncated. Open GitHub to inspect the complete diff.
            </p>
          )}
          {!query.data.files.length && <p>No changed files on this page.</p>}
          {query.data.files.map((file) => (
            <details key={file.path} open className="min-w-0 rounded-md border border-border">
              <summary className="flex cursor-pointer flex-wrap items-center gap-3 bg-panel px-3 py-2 focus-ring">
                <span className="min-w-0 flex-1 break-all font-mono text-sm">
                  {file.previousPath ? `${file.previousPath} → ` : ""}
                  {file.path}
                </span>
                <span className="text-xs text-muted-foreground">{file.status}</span>
                <DiffStat additions={file.additions} deletions={file.deletions} />
              </summary>
              {file.patch ? (
                <pre className="max-h-[60vh] overflow-auto p-3 font-mono text-xs leading-relaxed">
                  <code>{file.patch}</code>
                </pre>
              ) : (
                <p className="p-3 text-sm">GitHub did not provide a text patch for this file.</p>
              )}
              {file.truncated && (
                <p role="status" className="px-3 pb-3 text-sm">
                  Patch omitted or truncated.
                </p>
              )}
            </details>
          ))}
          <div className="flex gap-3">
            <Button disabled={page === 1} onClick={() => setPage(page - 1)}>
              Previous files
            </Button>
            <span>Page {page}</span>
            <Button
              disabled={!query.data.nextPage}
              onClick={() => query.data?.nextPage && setPage(query.data.nextPage)}
            >
              Next files
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
