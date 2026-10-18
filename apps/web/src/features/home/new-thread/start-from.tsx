import { useState } from "react";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import type { ForgeIssueList, ForgePrList } from "@ace/protocol";
import {
  useFailingPullRequests,
  useOpenIssues,
  useOpenPullRequests,
} from "@/features/forge/index.ts";
import { Tabs, TabsList, TabsPanel, TabsTab } from "@/components/ui/tabs.tsx";
import { cn } from "@/lib/cn.ts";
import { useDebouncedValue } from "@/lib/debounced.ts";
import { issueRows, pullRequestRows, startRowLimit } from "./start-from-model.ts";
import { StartRows } from "./start-rows.tsx";

/** What a new thread starts from: one pull request or issue, by its URL. */
export interface StartSource {
  pullRequest?: string | undefined;
  issue?: string | undefined;
}

type Kind = "pullRequests" | "issues";

/** GitHub's search API allows 30 requests a minute: let typing settle a little longer. */
const searchSettleMs = 300;

/**
 * The project's open pull requests and issues under the New thread composer. Picking one fills
 * the composer from it, as the PR panel's "New thread" does. A list that is empty, still loading
 * or unreachable (no GitHub remote, offline) takes no space; with neither, nothing renders. A
 * list longer than a few rows can be searched on GitHub and shows the rest it loaded on request.
 */
export function StartFrom(props: {
  project: string;
  source: StartSource;
  onPick(source: StartSource): void;
}) {
  const prs = useOpenPullRequests(props.project);
  const issues = useOpenIssues(props.project);
  const [picked, setPicked] = useState<Kind>(props.source.issue ? "issues" : "pullRequests");
  const [text, setText] = useState("");
  const search = useDebouncedValue(text.trim(), searchSettleMs);
  const lists: { kind: Kind; label: string; total: number }[] = [];
  if (prs.data?.items.length)
    lists.push({ kind: "pullRequests", label: "Pull requests", total: prs.data.total });
  if (issues.data?.items.length)
    lists.push({ kind: "issues", label: "Issues", total: issues.data.total });
  const first = lists[0];
  if (!first) return null;
  const active = lists.find((list) => list.kind === picked) ?? first;
  const chosen = props.source.pullRequest ?? props.source.issue;
  return (
    <section aria-label="Open work" className="mt-6 px-1">
      <Tabs value={active.kind} onValueChange={(value: Kind) => setPicked(value)}>
        <div className="mb-1.5 flex min-w-0 items-center gap-2">
          <TabsList>
            {lists.map((list) => (
              <TabsTab key={list.kind} value={list.kind}>
                {list.label}{" "}
                <span className="font-normal text-subtle-foreground tabular-nums">
                  {list.total}
                </span>
              </TabsTab>
            ))}
          </TabsList>
          {(active.total > startRowLimit || text) && (
            <label className="ml-auto flex h-7 w-52 min-w-0 items-center gap-1.5 rounded-md px-2 text-muted-foreground transition-colors duration-(--motion-fast) focus-within:bg-foreground/5 hover:bg-foreground/3">
              <MagnifyingGlassIcon aria-hidden size={14} className="shrink-0" />
              <input
                type="search"
                value={text}
                aria-label={`Search ${active.label.toLowerCase()}`}
                placeholder="Search"
                onChange={(event) => setText(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key !== "Escape" || !text) return;
                  event.stopPropagation();
                  setText("");
                }}
                className="min-w-0 flex-1 bg-transparent text-ui text-foreground outline-none placeholder:text-subtle-foreground [&::-webkit-search-cancel-button]:hidden"
              />
            </label>
          )}
        </div>
        <TabsPanel value="pullRequests">
          {prs.data && active.kind === "pullRequests" && (
            <PullRequests
              project={props.project}
              search={search}
              all={prs.data}
              chosen={chosen}
              onPick={(url) => props.onPick({ pullRequest: url })}
            />
          )}
        </TabsPanel>
        <TabsPanel value="issues">
          {issues.data && active.kind === "issues" && (
            <Issues
              project={props.project}
              search={search}
              all={issues.data}
              chosen={chosen}
              onPick={(url) => props.onPick({ issue: url })}
            />
          )}
        </TabsPanel>
      </Tabs>
    </section>
  );
}

interface ListProps<T> {
  project: string;
  /** What the person searched for; empty shows `all`. */
  search: string;
  all: T;
  chosen: string | undefined;
  onPick(url: string): void;
}

/** While a search is on its way, the rows it replaces stay, dimmed. */
const searching = "opacity-60 transition-opacity duration-(--motion-fast)";

function PullRequests(props: ListProps<ForgePrList>) {
  const found = useOpenPullRequests(props.project, props.search, props.search !== "");
  // Failing PRs lead the unsearched list even when older than its first page.
  const failing = useFailingPullRequests(props.project).data?.items ?? [];
  // A failed search shows no rows rather than the unsearched list it would pass for.
  const list = !props.search ? props.all : found.isError ? undefined : (found.data ?? props.all);
  const busy = !!props.search && found.isFetching;
  return (
    <div aria-busy={busy} className={cn(busy && searching)}>
      <StartRows
        key={props.search}
        rows={list ? pullRequestRows(list.items, props.search ? [] : failing) : []}
        chosen={props.chosen}
        none={found.isError ? "Couldn't search pull requests." : "No open pull requests match."}
        onPick={props.onPick}
      />
    </div>
  );
}

function Issues(props: ListProps<ForgeIssueList>) {
  const found = useOpenIssues(props.project, props.search, props.search !== "");
  // A failed search shows no rows rather than the unsearched list it would pass for.
  const list = !props.search ? props.all : found.isError ? undefined : (found.data ?? props.all);
  const busy = !!props.search && found.isFetching;
  return (
    <div aria-busy={busy} className={cn(busy && searching)}>
      <StartRows
        key={props.search}
        rows={list ? issueRows(list.items) : []}
        chosen={props.chosen}
        none={found.isError ? "Couldn't search issues." : "No open issues match."}
        onPick={props.onPick}
      />
    </div>
  );
}
