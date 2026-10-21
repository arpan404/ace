import { useState } from "react";
import { EyeIcon, GitPullRequestIcon, UserIcon, UsersIcon } from "@phosphor-icons/react";
import type { ForgePrRow } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { FilterMenu } from "@/components/ui/filter-menu.tsx";
import { SegmentedControl } from "@/components/ui/segmented-control.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { useViewListKeys } from "@/components/ui/view-row.tsx";
import { Screen } from "@/features/shell/index.ts";
import { cn } from "@/lib/cn.ts";
import { DetailSplit } from "./detail-split.tsx";
import { FiltersMenu, type FilterSection } from "./filters-menu.tsx";
import { useLinkedThreads, workKey } from "./linked-threads.ts";
import { ListFrame } from "./list-frame.tsx";
import { usePrPages } from "./lists.ts";
import { PrPanel } from "./pr-panel.tsx";
import { PrRow } from "./pr-row.tsx";
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
 * the rest; the chosen one opens beside the list. Every filter lives in the address.
 */
export function PullRequestsPage(props: {
  search: PullsSearch;
  onSearch(patch: Partial<PullsSearch>): void;
}) {
  const { search, onSearch } = props;
  const choice = useProjectChoice(search.project);
  const project = choice.project;
  const query = prQuery(search, 1);
  const listKey = JSON.stringify([project, query]);
  const [paging, setPaging] = useState({ key: listKey, pages: 1 });
  const pages = paging.key === listKey ? paging.pages : 1;
  const list = usePrPages(project, query, pages);
  const linked = useLinkedThreads().pulls;
  const keys = useViewListKeys<HTMLElement>();
  const sort: PullsSort = search.sort ?? "ready";
  const groups = groupPrs(sortPrs(list.rows, sort), list.first?.viewer);
  const counts = list.first?.counts;
  const stateOptions = [
    { value: "open" as const, label: counts ? `Open ${counts.open + counts.draft}` : "Open" },
    { value: "merged" as const, label: counts ? `Merged ${counts.merged}` : "Merged" },
    { value: "closed" as const, label: counts ? `Closed ${counts.closed}` : "Closed" },
    { value: "all" as const, label: "All" },
  ];
  const close = () => onSearch({ pr: undefined, repo: undefined, tab: undefined });
  const rows = (
    <ListFrame
      kind="pulls"
      search={search.q ?? ""}
      onSearch={(text) => onSearch({ q: text.trim() || undefined })}
      controls={
        <>
          <SegmentedControl
            label="Involvement"
            size="sm"
            value={search.who ?? "all"}
            options={[
              { value: "all", label: "All" },
              { value: "authored", label: "Authored" },
              { value: "reviewing", label: "Reviewing" },
            ]}
            onValueChange={(who) => onSearch({ who: who === "all" ? undefined : who })}
          />
          <FilterMenu
            label="State"
            value={search.state ?? "open"}
            options={stateOptions}
            onValueChange={(state) => onSearch({ state: state === "open" ? undefined : state })}
          />
          {project && choice.projects.length > 1 && (
            <FilterMenu
              label="Project"
              value={project}
              options={choice.projects.map((id) => ({ value: id, label: choice.name(id) }))}
              onValueChange={(next) => {
                choice.remember(next);
                onSearch({
                  project: next,
                  pr: undefined,
                  repo: undefined,
                  labels: undefined,
                  author: undefined,
                });
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
        <ListSkeleton label="pull requests" shape="row" rows={8} className="px-4" />
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
                  count={group.rows.length}
                />
              ) : null}
              <ul>
                {group.rows.map((row) => (
                  <PrRow
                    key={`${row.ref.repository.owner}/${row.ref.repository.name}#${row.ref.number}`}
                    project={project}
                    row={row}
                    selected={search.pr === row.ref.number}
                    thread={linked.get(workKey(row.ref.repository, row.ref.number))}
                  />
                ))}
              </ul>
            </section>
          ))}
          {list.more && (
            <div className="px-4 pt-2">
              <Button
                size="sm"
                variant="ghost"
                onClick={() => setPaging({ key: listKey, pages: pages + 1 })}
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
      <DetailSplit
        list={rows}
        panelLabel={search.pr ? `Pull request #${search.pr}` : "Pull request"}
        onClose={close}
        panel={
          project && search.pr ? (
            <PrPanel
              project={project}
              number={search.pr}
              repo={search.repo}
              tab={search.tab ?? "summary"}
              onSearch={onSearch}
            />
          ) : null
        }
      />
    </Screen>
  );
}
