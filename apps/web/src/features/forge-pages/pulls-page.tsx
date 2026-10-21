import { useState } from "react";
import { useLocation } from "@tanstack/react-router";
import {
  CheckCircleIcon,
  CircleDashedIcon,
  ClockIcon,
  EyeIcon,
  GitPullRequestIcon,
  UserIcon,
  UsersIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import type { ForgePrRow } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { FilterMenu } from "@/components/ui/filter-menu.tsx";
import { WordChoice } from "@/components/ui/word-choice.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useViewListKeys } from "@/components/ui/view-row.tsx";
import { Screen } from "@/features/shell/index.ts";
import { cn } from "@/lib/cn.ts";
import { FiltersMenu, type FilterSection } from "./filters-menu.tsx";
import { useLinkedThreads, workKey } from "./linked-threads.ts";
import { ListFrame, ToolbarRule } from "./list-frame.tsx";
import { useGroupCounts, usePrPages } from "./lists.ts";
import { PrRow } from "./pr-row.tsx";
import { useReadyPages } from "./ready-pages.ts";
import { rankByReadiness } from "./ready-ranking.ts";
import { useProjectChoice } from "./project-choice.ts";
import {
  groupPrs,
  prQuery,
  sortLabels,
  sortPrs,
  type PullsSearch,
  type PullsSort,
} from "./pulls-model.ts";
import { GroupHeader } from "./row-parts.tsx";

const groupIcons = {
  authored: UserIcon,
  reviewing: EyeIcon,
  others: UsersIcon,
  all: GitPullRequestIcon,
  ready: CheckCircleIcon,
  checks: ClockIcon,
  review: EyeIcon,
  changes: XCircleIcon,
  other: CircleDashedIcon,
  drafts: GitPullRequestIcon,
} as const;
const unique = (values: readonly string[]) =>
  [...new Set(values)].toSorted((a, b) => a.localeCompare(b));

function filterSections(
  search: PullsSearch,
  rows: readonly ForgePrRow[],
  onSearch: (patch: Partial<PullsSearch>) => void,
): FilterSection[] {
  return [
    {
      kind: "one",
      id: "draft",
      label: "Drafts",
      value: search.draft ?? "",
      choices: [
        { value: "", label: "Include drafts" },
        { value: "only", label: "Drafts only" },
        { value: "hide", label: "Hide drafts" },
      ],
      onChange: (value) =>
        onSearch({ draft: value === "only" || value === "hide" ? value : undefined }),
    },
    {
      kind: "one",
      id: "review",
      label: "Review",
      value: search.review ?? "",
      choices: [
        { value: "", label: "Any review" },
        { value: "approved", label: "Approved" },
        { value: "changes", label: "Changes requested" },
        { value: "required", label: "Review required" },
        { value: "none", label: "No review" },
      ],
      onChange: (value) =>
        onSearch({
          review:
            value === "approved" || value === "changes" || value === "required" || value === "none"
              ? value
              : undefined,
        }),
    },
    {
      kind: "one",
      id: "checks",
      label: "Checks",
      value: search.checks ?? "",
      choices: [
        { value: "", label: "Any checks" },
        { value: "passing", label: "Passing" },
        { value: "failing", label: "Failing" },
      ],
      onChange: (value) =>
        onSearch({ checks: value === "passing" || value === "failing" ? value : undefined }),
    },
    {
      kind: "one",
      id: "author",
      label: "Author",
      value: search.author ?? "",
      choices: [
        { value: "", label: "Anyone" },
        ...unique([
          ...rows.map((row) => row.author),
          ...(search.author ? [search.author] : []),
        ]).map((login) => ({ value: login, label: login })),
      ],
      onChange: (value) => onSearch({ author: value || undefined }),
    },
    {
      kind: "many",
      id: "labels",
      label: "Labels",
      values: search.labels ?? [],
      choices: unique([...rows.flatMap((row) => row.labels), ...(search.labels ?? [])]).map(
        (label) => ({ value: label, label }),
      ),
      onChange: (labels) => onSearch({ labels: labels.length ? labels : undefined }),
    },
  ];
}

/**
 * A project's pull requests across the main column, grouped as yours, waiting on your review and
 * the rest; a row opens its pull request as a page. Every filter lives in the address.
 */
export function PullRequestsPage(props: {
  search: PullsSearch;
  onSearch(patch: Partial<PullsSearch>): void;
}) {
  const { search, onSearch } = props;
  const choice = useProjectChoice(search.project);
  const listAddress = useLocation({ select: (location) => location.searchStr });
  const project = choice.project;
  const query = prQuery(search, 1);
  const listKey = JSON.stringify([project, query]);
  const [paging, setPaging] = useState({ key: listKey, pages: 1 });
  const pages = paging.key === listKey ? paging.pages : 1;
  const sort: PullsSort = search.sort ?? "ready";
  const listed = usePrPages(project, query, pages);
  // "Ready to merge" ranks the whole repository, so it reads its own pages, readiest first.
  // Readiness ranks open pull requests; merged or closed ones group by who they concern.
  const byReadiness = sort === "ready" && (search.state ?? "open") === "open";
  const ranked = useReadyPages(project, search, byReadiness);
  const list = byReadiness ? ranked : listed;
  const totals = useGroupCounts(
    project,
    byReadiness ? { by: "readiness", query } : { by: "pr-people", query },
  ).data;
  const linked = useLinkedThreads().pulls;
  const keys = useViewListKeys<HTMLElement>();
  const groups = byReadiness
    ? rankByReadiness(list.rows)
    : groupPrs(sortPrs(list.rows, sort === "ready" ? "updated" : sort), list.first?.viewer);
  const counts = list.first?.counts;
  const stateOptions = [
    { value: "open" as const, label: "Open", count: counts && counts.open + counts.draft },
    { value: "merged" as const, label: "Merged", count: counts?.merged },
    { value: "closed" as const, label: "Closed", count: counts?.closed },
    { value: "all" as const, label: "All" },
  ];
  const rows = (
    <ListFrame
      kind="pulls"
      address={listAddress}
      ready={list.rows.length > 0}
      search={search.q ?? ""}
      onSearch={(text) => onSearch({ q: text.trim() || undefined })}
      controls={
        <>
          <WordChoice
            label="State"
            value={search.state ?? "open"}
            options={stateOptions}
            onValueChange={(state) => onSearch({ state: state === "open" ? undefined : state })}
          />
          <ToolbarRule />
          <WordChoice
            label="Involvement"
            value={search.who ?? "all"}
            options={[
              { value: "all", label: "Everyone" },
              { value: "authored", label: "Authored" },
              { value: "reviewing", label: "Reviewing" },
            ]}
            onValueChange={(who) => onSearch({ who: who === "all" ? undefined : who })}
          />
        </>
      }
      menus={
        <>
          {project && choice.projects.length > 1 && (
            <FilterMenu
              label="Project"
              value={project}
              options={choice.projects.map((id) => ({ value: id, label: choice.name(id) }))}
              onValueChange={(next) => {
                choice.remember(next);
                onSearch({ project: next, labels: undefined, author: undefined });
              }}
            />
          )}
          <FilterMenu
            label="Sort"
            value={sort}
            options={(Object.keys(sortLabels) as PullsSort[]).map((value) => ({
              value,
              label: sortLabels[value],
            }))}
            onValueChange={(next) => onSearch({ sort: next === "ready" ? undefined : next })}
          />
          <FiltersMenu
            sections={filterSections(search, list.rows, onSearch)}
            onClear={() =>
              onSearch({
                draft: undefined,
                review: undefined,
                checks: undefined,
                author: undefined,
                labels: undefined,
              })
            }
          />
        </>
      }
    >
      {!project ? (
        choice.loaded && (
          <EmptyState
            title="No projects yet"
            description="Add a project with a GitHub remote to see its pull requests."
          />
        )
      ) : list.error && !list.first ? (
        <EmptyState
          title="Couldn't load pull requests"
          description={list.error.message}
          action={
            <Button size="sm" onClick={list.retry}>
              Try again
            </Button>
          }
        />
      ) : list.loading ? (
        <ListSkeleton label="pull requests" shape="row" rows={8} className="px-(--forge-gutter)" />
      ) : !list.rows.length ? (
        <EmptyState title="No pull requests match" />
      ) : (
        <nav
          aria-label="Pull requests"
          aria-busy={list.stale}
          {...keys}
          className={cn(
            "pb-6",
            list.stale && "opacity-60 transition-opacity duration-(--motion-fast)",
          )}
        >
          {groups.map((group) => (
            <section key={group.id} aria-label={group.label}>
              {groups.length > 1 || group.id !== "all" ? (
                <GroupHeader
                  icon={groupIcons[group.id as keyof typeof groupIcons] ?? UsersIcon}
                  label={group.label}
                  count={totals?.[group.id]}
                />
              ) : null}
              <ul>
                {group.rows.map((row) => (
                  <PrRow
                    key={`${row.ref.repository.owner}/${row.ref.repository.name}#${row.ref.number}`}
                    project={project}
                    back={listAddress}
                    row={row}
                    thread={linked.get(workKey(row.ref.repository, row.ref.number))}
                  />
                ))}
              </ul>
            </section>
          ))}
          {list.more && (
            <div className="px-(--forge-gutter) pt-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  byReadiness ? ranked.loadMore() : setPaging({ key: listKey, pages: pages + 1 })
                }
              >
                Show more
              </Button>
            </div>
          )}
        </nav>
      )}
    </ListFrame>
  );
  return (
    <Screen title="Pull requests" crumb={project ? choice.name(project) : undefined}>
      {rows}
    </Screen>
  );
}
