import { useState } from "react";
import type { ForgePrDetail, ForgeRepository } from "@ace/protocol";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { Button } from "@/components/ui/button.tsx";
import { readForge } from "./source.ts";
import { QueryState } from "./query-state.tsx";
import { PrFiles } from "./pr-files.tsx";

export function PrCommits(props: {
  workspaceId: string;
  repository: ForgeRepository;
  detail: ForgePrDetail;
}) {
  const [page, setPage] = useState(1);
  const [commit, setCommit] = useState<string>();
  const ref = props.detail.status.ref;
  const query = useDaemonQuery({
    queryKey: ["forge", props.workspaceId, ref, "commits", props.detail.status.headSha, page],
    retry: false,
    read: async (client, signal) => {
      const result = await readForge(
        client,
        {
          op: "forge.pr.commits",
          workspaceId: props.workspaceId,
          repository: props.repository,
          number: ref.number,
          headSha: props.detail.status.headSha,
          page,
        },
        signal,
      );
      if (result.resource !== "prCommits") throw new Error("No commit response.");
      return result;
    },
  });
  return (
    <section aria-label="Pull request commits" className="space-y-4">
      <QueryState query={query} />
      {query.data && (
        <>
          {query.data.truncated && (
            <p role="status">
              GitHub exposes the first 250 PR commits here. Open GitHub for the complete history.
            </p>
          )}
          <ul>
            {query.data.commits.map((item) => (
              <li
                key={item.sha}
                className="flex flex-wrap items-center gap-3 border-b border-border py-3"
              >
                <Button
                  variant="link"
                  aria-pressed={commit === item.sha}
                  onClick={() => setCommit(item.sha)}
                >
                  {item.sha.slice(0, 8)}
                </Button>
                <span className="min-w-0 flex-1 whitespace-pre-wrap break-words">
                  {item.message}
                </span>
                <span className="text-sm text-muted-foreground">{item.author}</span>
              </li>
            ))}
          </ul>
          {!query.data.commits.length && <p>No commits on this page.</p>}
          <div className="flex gap-3">
            <Button disabled={page === 1} onClick={() => setPage(page - 1)}>
              Previous commits
            </Button>
            <Button
              disabled={!query.data.nextPage}
              onClick={() => query.data?.nextPage && setPage(query.data.nextPage)}
            >
              Next commits
            </Button>
          </div>
        </>
      )}
      {commit && <PrFiles key={commit} {...props} commit={commit} />}
    </section>
  );
}
