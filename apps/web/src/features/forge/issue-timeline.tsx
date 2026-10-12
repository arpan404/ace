import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { ForgeIssueRef } from "@ace/protocol";
import { prFromUrl } from "@ace/forge/pr-reference";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { Button } from "@/components/ui/button.tsx";
import { Prose } from "@/components/markdown/prose.tsx";
import { QueryState } from "./query-state.tsx";
import { readForge } from "./source.ts";
function reference(value: string | undefined) {
  try {
    return value ? prFromUrl(value) : undefined;
  } catch {
    return undefined;
  }
}
export function IssueTimeline(props: {
  workspaceId: string;
  issue: ForgeIssueRef;
  revision: number;
}) {
  const [page, setPage] = useState(1);
  const query = useDaemonQuery({
    queryKey: ["forge", props.workspaceId, props.issue, "issueTimeline", page, props.revision],
    retry: false,
    refetchOnReconnect: "always",
    read: async (client, signal) => {
      const value = await readForge(
        client,
        {
          op: "forge.issue.timeline",
          workspaceId: props.workspaceId,
          repository: props.issue.repository,
          number: props.issue.number,
          page,
        },
        signal,
      );
      if (value.resource !== "issueTimeline") throw new Error("No issue conversation.");
      return value;
    },
  });
  return (
    <section aria-label="Issue conversation" className="space-y-4">
      <h3 className="font-medium">GitHub issue conversation</h3>
      <QueryState query={query} />
      {query.data && (
        <>
          <ol className="space-y-4">
            {query.data.events.map((event) => {
              const pr = reference(event.pullRequestUrl);
              return (
                <li key={event.id} className="border-t border-border pt-3">
                  <p className="mb-2 text-sm text-muted-foreground">
                    {event.actor} ·{" "}
                    {event.kind === "issue_comment"
                      ? "Issue comment"
                      : event.event.replaceAll("_", " ")}{" "}
                    · {event.at ?? "Date unknown"}
                  </p>
                  {event.body && <Prose text={event.body} />}{" "}
                  {pr && (
                    <Link
                      className="text-link hover:underline focus-ring"
                      to="/pull-requests"
                      search={{
                        project: props.workspaceId,
                        repo: `${pr.repository.host}/${pr.repository.owner}/${pr.repository.name}`,
                        number: pr.number,
                      }}
                    >
                      Referenced PR #{pr.number}
                    </Link>
                  )}
                </li>
              );
            })}
          </ol>
          {query.data.truncated && (
            <p>Conversation is truncated. Open GitHub for older activity.</p>
          )}
          <div className="flex gap-2">
            <Button disabled={page === 1} onClick={() => setPage(page - 1)}>
              Previous conversation
            </Button>
            <Button
              disabled={!query.data.nextPage}
              onClick={() => query.data?.nextPage && setPage(query.data.nextPage)}
            >
              Next conversation
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
