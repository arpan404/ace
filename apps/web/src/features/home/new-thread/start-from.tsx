import { useState } from "react";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import type { ForgeIssueRow, ForgePrRow } from "@ace/protocol";
import { useOpenIssues, useOpenPullRequests, useOpenWork } from "@/features/forge/index.ts";
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
  const work = useOpenWork(props.project).data;
  const [picked, setPicked] = useState<Kind>(props.source.issue ? "issues" : "pullRequests");
  const [text, setText] = useState("");
  const search = useDebouncedValue(text.trim(), searchSettleMs);
  const lists: { kind: Kind; label: string; total: number }[] = [];
  if (work?.pullRequests.items.length)
    lists.push({ kind: "pullRequests", label: "Pull requests", total: work.pullRequests.total });
  if (work?.issues.items.length)
    lists.push({ kind: "issues", label: "Issues", total: work.issues.total });
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
            <label className="ml-auto flex h-7 w-52 min-w-0 items-center gap-1.5 rounded-md px-2 text-muted-foreground transition-colors duration-(--motion-fast) has-focus-visible:shadow-[0_0_0_2px_var(--background),0_0_0_4px_var(--focus,var(--ring))] focus-within:bg-foreground/5 hover:bg-foreground/3">
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
                className="min-w-0 flex-1 bg-transparent text-ui text-foreground placeholder:text-subtle-foreground focus:outline-none [&::-webkit-search-cancel-button]:hidden"
              />
            </label>
          )}
        </div>
        <TabsPanel value="pullRequests">
          {work && active.kind === "pullRequests" && (
            <PullRequests
              project={props.project}
              search={search}
              all={work.pullRequests.items}
              failing={work.failingPullRequests.items}
              chosen={chosen}
              onPick={(url) => props.onPick({ pullRequest: url })}
            />
          )}
        </TabsPanel>
        <TabsPanel value="issues">
          {work && active.kind === "issues" && (
            <Issues
              project={props.project}
              search={search}
              all={work.issues.items}
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
  all: readonly T[];
  chosen: string | undefined;
  onPick(url: string): void;
}

/** While a search is on its way, the rows it replaces stay, dimmed. */
const searching = "opacity-60 transition-opacity duration-(--motion-fast)";

function PullRequests(props: ListProps<ForgePrRow> & { failing: readonly ForgePrRow[] }) {
  const found = useOpenPullRequests(props.project, props.search, props.search !== "");
  // A failed search shows no rows rather than the unsearched list it would pass for.
  const list = !props.search
    ? props.all
    : found.isError
      ? undefined
      : (found.data?.items ?? props.all);
  const busy = !!props.search && found.isFetching;
  return (
    <div aria-busy={busy} className={cn(busy && searching)}>
      <StartRows
        key={props.search}
        // Failing PRs lead the unsearched list even when older than its first page.
        rows={list ? pullRequestRows(list, props.search ? [] : props.failing) : []}
        chosen={props.chosen}
        none={found.isError ? "Couldn't search pull requests." : "No open pull requests match."}
        onPick={props.onPick}
      />
    </div>
  );
}

function Issues(props: ListProps<ForgeIssueRow>) {
  const found = useOpenIssues(props.project, props.search, props.search !== "");
  // A failed search shows no rows rather than the unsearched list it would pass for.
  const list = !props.search
    ? props.all
    : found.isError
      ? undefined
      : (found.data?.items ?? props.all);
  const busy = !!props.search && found.isFetching;
  return (
    <div aria-busy={busy} className={cn(busy && searching)}>
      <StartRows
        key={props.search}
        rows={list ? issueRows(list) : []}
        chosen={props.chosen}
        none={found.isError ? "Couldn't search issues." : "No open issues match."}
        onPick={props.onPick}
      />
    </div>
  );
}
