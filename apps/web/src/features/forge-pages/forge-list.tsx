import { useState } from "react";
import type { ForgeIssueList, ForgePrList } from "@ace/protocol";
import type { UseQueryResult } from "@tanstack/react-query";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useViewListKeys } from "@/components/ui/view-row.tsx";
import { cn } from "@/lib/cn.ts";
import { issueQuery, prQuery, type ForgeFilters } from "./filters.ts";
import { useLinkedThreads, workKey } from "./linked-threads.ts";
import { useIssueListPage, usePrListPage } from "./lists.ts";
import { IssueListRow, PrListRow } from "./rows.tsx";

interface ListProps {
  project: string;
  filters: ForgeFilters;
  search: string;
  /** The list's own words: what an empty list is, with and without a search. */
  none: string;
}

/** While a new search or filter reads, the rows it replaces stay, dimmed. */
const settling = "opacity-60 transition-opacity duration-(--motion-fast)";

function Failure(props: { error: Error; onRetry(): void }) {
  return (
    <EmptyState
      variant="inline"
      title={props.error.message || "Couldn't load the list."}
      action={
        <Button size="sm" variant="ghost" onClick={props.onRetry}>
          Try again
        </Button>
      }
    />
  );
}

/**
 * One page of a list, and the next after it once asked for: pages are read one at a time,
 * newest activity first, as GitHub's search pages them.
 */
function Page<T extends ForgePrList | ForgeIssueList>(props: {
  query: UseQueryResult<T, Error>;
  first: boolean;
  none: string;
  rows: React.ReactNode;
  next: Omit<ListProps, "none"> & { kind: "pulls" | "issues"; none: string };
}) {
  const [more, setMore] = useState(false);
  const { query } = props;
  if (query.isError && !query.data)
    return <Failure error={query.error} onRetry={() => void query.refetch()} />;
  const list = query.data;
  if (!list) return props.first ? <ListSkeleton label="list" shape="row" rows={6} /> : null;
  if (props.first && !list.items.length) return <EmptyState variant="inline" title={props.none} />;
  return (
    <>
      <ul
        aria-busy={query.isPlaceholderData}
        className={cn("flex flex-col gap-px", query.isPlaceholderData && settling)}
      >
        {props.rows}
      </ul>
      {list.nextPage !== undefined &&
        (more ? (
          props.next.kind === "pulls" ? (
            <PrPage {...props.next} page={list.nextPage} />
          ) : (
            <IssuePage {...props.next} page={list.nextPage} />
          )
        ) : (
          <Button
            size="sm"
            variant="ghost"
            className="mt-1 w-full justify-start text-muted-foreground"
            onClick={() => setMore(true)}
          >
            Show more
          </Button>
        ))}
    </>
  );
}

function PrPage(props: ListProps & { page: number }) {
  const query = usePrListPage(props.project, prQuery(props.filters, props.search, props.page));
  const linked = useLinkedThreads().pulls;
  return (
    <Page
      query={query}
      first={props.page === 1}
      none={props.none}
      rows={query.data?.items.map((row) => (
        <li key={row.ref.number}>
          <PrListRow
            project={props.project}
            row={row}
            thread={linked.get(workKey(row.ref.repository, row.ref.number))}
          />
        </li>
      ))}
      next={{ ...props, kind: "pulls" }}
    />
  );
}

function IssuePage(props: ListProps & { page: number }) {
  const query = useIssueListPage(
    props.project,
    issueQuery(props.filters, props.search, props.page),
  );
  const linked = useLinkedThreads().issues;
  return (
    <Page
      query={query}
      first={props.page === 1}
      none={props.none}
      rows={query.data?.items.map((row) => (
        <li key={row.ref.number}>
          <IssueListRow
            project={props.project}
            row={row}
            thread={linked.get(workKey(row.ref.repository, row.ref.number))}
          />
        </li>
      ))}
      next={{ ...props, kind: "issues" }}
    />
  );
}

/** A project's pull requests or issues: ↑/↓ move between rows, Enter opens one. */
export function ForgeList(props: ListProps & { kind: "pulls" | "issues" }) {
  const keys = useViewListKeys<HTMLElement>();
  const { kind, ...list } = props;
  return (
    <nav aria-label={kind === "pulls" ? "Pull requests" : "Issues"} {...keys}>
      {kind === "pulls" ? <PrPage {...list} page={1} /> : <IssuePage {...list} page={1} />}
    </nav>
  );
}
