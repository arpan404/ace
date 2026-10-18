import { useState } from "react";
import { formatAge } from "@ace/ui-core";
import { useOpenIssues, useOpenPullRequests } from "@/features/forge/index.ts";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs.tsx";
import { cn } from "@/lib/cn.ts";
import { useNow } from "@/lib/time.ts";
import { issueRows, pullRequestRows, type StartRow } from "./start-from-model.ts";

/** What a new thread starts from: one pull request or issue, by its URL. */
export interface StartSource {
  pullRequest?: string | undefined;
  issue?: string | undefined;
}

type Kind = "pullRequests" | "issues";

/**
 * The project's open pull requests and issues under the New thread composer. Picking one fills
 * the composer from it, as the PR panel's "New thread" does. A list that is empty, still loading
 * or unreachable (no GitHub remote, offline) takes no space; with neither, nothing renders.
 */
export function StartFrom(props: {
  project: string;
  source: StartSource;
  onPick(source: StartSource): void;
}) {
  const prs = useOpenPullRequests(props.project);
  const issues = useOpenIssues(props.project);
  const now = useNow();
  const lists: { kind: Kind; label: string; rows: StartRow[] }[] = [];
  if (prs.data?.length)
    lists.push({ kind: "pullRequests", label: "Pull requests", rows: pullRequestRows(prs.data) });
  if (issues.data?.length)
    lists.push({ kind: "issues", label: "Issues", rows: issueRows(issues.data) });
  const [picked, setPicked] = useState<Kind>(props.source.issue ? "issues" : "pullRequests");
  const first = lists[0];
  if (!first) return null;
  const tab = lists.some((list) => list.kind === picked) ? picked : first.kind;
  const chosen = props.source.pullRequest ?? props.source.issue;
  return (
    <section aria-label="Open work" className="mt-6 px-1">
      <Tabs value={tab} onValueChange={(value: Kind) => setPicked(value)}>
        <TabsList className="mb-1.5">
          {lists.map((list) => (
            <TabsTab key={list.kind} value={list.kind}>
              {list.label}
            </TabsTab>
          ))}
        </TabsList>
        {lists.map((list) => (
          <TabsPanel key={list.kind} value={list.kind}>
            <ul className="flex flex-col">
              {list.rows.map((row) => (
                <li key={row.url}>
                  <button
                    type="button"
                    aria-current={row.url === chosen ? "true" : undefined}
                    onClick={() =>
                      props.onPick(
                        list.kind === "pullRequests"
                          ? { pullRequest: row.url }
                          : { issue: row.url },
                      )
                    }
                    className={cn(
                      "flex h-8 w-full min-w-0 items-center gap-3 rounded-md px-2.5 text-left text-ui text-foreground/85 transition-colors duration-(--motion-fast) focus-ring hover:bg-accent hover:text-foreground",
                      row.url === chosen && "bg-accent text-foreground",
                    )}
                  >
                    <span className="w-11 shrink-0 text-muted-foreground tabular-nums">
                      #{row.number}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{row.title}</span>
                    {row.note && (
                      <span
                        className={cn(
                          "max-w-40 shrink-0 truncate text-xs",
                          row.note.failed ? "text-status-failed" : "text-muted-foreground",
                        )}
                      >
                        {row.note.text}
                      </span>
                    )}
                    {row.updatedAt !== undefined && (
                      <span className="w-7 shrink-0 text-right text-xs text-subtle-foreground tabular-nums">
                        {formatAge(row.updatedAt, now)}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </TabsPanel>
        ))}
      </Tabs>
    </section>
  );
}
