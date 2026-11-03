import {
  groupByWork,
  groupPrs,
  prQuery,
  sortPrs,
  type PullsSearch,
  type PullsSort,
  type RowGroup,
} from "@ace/ui-core";
import { useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import type { ForgePrList, ForgePrRow, VerifyRun } from "@ace/protocol";
import { useVerifyRuns } from "@/lib/verify.ts";
import { useMergeMethod } from "@/features/forge/index.ts";
import { useProjectDialogs } from "@/features/projects/index.ts";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { FilterMenu } from "@/components/ui/filter-menu.tsx";
import { Screen } from "@/features/shell/index.ts";
import { FiltersMenu } from "./filters-menu.tsx";
import { ForgeList } from "./forge-list.tsx";
import { useLinkedThreads } from "./linked-threads.ts";
import { RowsSkeleton } from "./list-skeletons.tsx";
import { ListFrame } from "./list-frame.tsx";
import { useGroupCounts, usePrPages } from "./lists.ts";
import { NewInProject } from "./new-in-project.tsx";
import { PrRow } from "./pr-row.tsx";
import { filterSections, viewSections } from "./pull-filters.ts";
import { useReadyPages } from "./ready-pages.ts";
import { useMergeRun } from "./merge-run.ts";
import { MergeStrip } from "./merge-strip.tsx";
import { useRowSteps } from "./row-steps.ts";
import { useProjectChoice } from "./project-choice.ts";
import { ProjectMenu } from "./project-menu.tsx";
import { PartialNotice } from "./partial-notice.tsx";
import { countWords, QuickViews } from "./quick-views.tsx";

const noRuns: readonly VerifyRun[] = [];
const noRows: readonly ForgePrRow[] = [];

type View = "all" | "needs" | "review" | "yours";

const viewOf = (search: PullsSearch): View =>
  search.view === "needs"
    ? "needs"
    : search.who === "reviewing"
      ? "review"
      : search.who === "authored"
        ? "yours"
        : "all";
const viewPatch: Record<View, Partial<PullsSearch>> = {
  all: { view: undefined, who: undefined },
  needs: { view: "needs", who: undefined },
  review: { view: undefined, who: "reviewing" },
  yours: { view: undefined, who: "authored" },
};

/**
 * Pull requests across the main column, from every project unless some are picked: open ones
 * grouped by who has the next move (Needs you, Agents working, Waiting on others, Ready to
 * merge), each row saying its state in words. Every filter lives in the address.
 */
export function PullRequestsPage(props: {
  search: PullsSearch;
  onSearch(patch: Partial<PullsSearch>): void;
}) {
  const { search, onSearch } = props;
  const choice = useProjectChoice(search);
  const listAddress = useLocation({ select: (location) => location.searchStr });
  const projects = choice.projects;
  const single = choice.one;
  const query = prQuery(search, 1);
  const listKey = JSON.stringify([projects, query]);
  const [paging, setPaging] = useState({ key: listKey, pages: 1 });
  const pages = paging.key === listKey ? paging.pages : 1;
  const sort: PullsSort = search.sort ?? "ready";
  const open = (search.state ?? "open") === "open";
  // By next move on open pull requests. One project is ranked readiest first through the whole
  // repository; several are read newest first, a page per project at a time.
  const byWork = sort === "ready" && open;
  const listed = usePrPages(projects, query, pages);
  const ranked = useReadyPages(single, search, byWork && single !== undefined);
  const list = byWork && single !== undefined ? ranked : listed;
  const peopleQuery = prQuery({ ...search, who: undefined }, 1);
  const people = useGroupCounts(open ? projects : [], { by: "pr-people", query: peopleQuery });
  const totals = useGroupCounts(byWork ? [] : projects, { by: "pr-people", query }).total;
  const linked = useLinkedThreads().pulls;
  // Local checks and the verified merge are a project's own: with one project shown.
  const verify = useVerifyRuns(single);
  const runs = verify.data?.runs ?? noRuns;
  const steps = useRowSteps({
    back: listAddress,
    rows: list.rows,
    projectOf: list.projectOf,
    viewer: list.first?.viewer,
    linked,
    runs,
    command: verify.data?.command,
  });
  const view = viewOf(search);
  const needsYou = list.rows.filter((row) => steps.groupOf(row) === "you");
  const shown = open && view === "needs" ? needsYou : list.rows;
  const groups: RowGroup<ForgePrRow>[] = byWork
    ? groupByWork(shown, (row) => steps.stepOf(row).step, steps.threadOf)
    : groupPrs(sortPrs(shown, sort === "ready" ? "updated" : sort), list.first?.viewer);
  const merge = useMergeRun(
    single ?? "",
    single ? (groups.find((group) => group.id === "merge")?.rows ?? noRows) : noRows,
    runs,
  );
  const [method, setMethod] = useMergeMethod(single ?? "");
  const navigate = useNavigate();
  const dialogs = useProjectDialogs();
  const complete = !list.more;
  const count = (group: RowGroup<ForgePrRow>) =>
    countWords(group.rows.length, byWork ? undefined : totals?.[group.id], complete);
  const sum = (pick: (counts: ForgePrList["counts"]) => number) => {
    if (list.firsts.size < projects.length) return undefined;
    let total = 0;
    for (const first of list.firsts.values()) total += pick(first.counts);
    return total;
  };
  const openCounts = new Map(
    [...list.firsts].map(([id, first]) => [id, first.counts.open + first.counts.draft]),
  );
  const peopleTotal = people.total;
  const stateOptions = [
    { value: "open" as const, label: "Open", count: sum((c) => c.open + c.draft) },
    { value: "merged" as const, label: "Merged", count: sum((c) => c.merged) },
    { value: "closed" as const, label: "Closed", count: sum((c) => c.closed) },
    { value: "all" as const, label: "All" },
  ];
  const views = open ? (
    <QuickViews
      label="Views"
      value={view}
      onValue={(next) => onSearch(viewPatch[next])}
      views={[
        {
          id: "all",
          label: "All open",
          count: peopleTotal
            ? String(Object.values(peopleTotal).reduce((a, b) => a + b, 0))
            : undefined,
        },
        {
          id: "needs",
          label: "Needs you",
          count: countWords(needsYou.length, undefined, complete),
        },
        {
          id: "review",
          label: "Review requested",
          count: peopleTotal ? String(peopleTotal["reviewing"] ?? 0) : undefined,
        },
        {
          id: "yours",
          label: "Yours",
          count: peopleTotal ? String(peopleTotal["authored"] ?? 0) : undefined,
        },
      ]}
    />
  ) : null;
  const openPr = (project: string, number: number) =>
    void navigate({
      to: "/pulls/$project/$number",
      params: { project, number: String(number) },
      search: { back: listAddress },
    });
  const rows = (
    <ListFrame
      kind="pulls"
      address={listAddress}
      ready={list.rows.length > 0}
      lead={
        <ProjectMenu
          choice={choice}
          counts={openCounts}
          onPick={(next) =>
            onSearch({ ...choice.pick(next), labels: undefined, author: undefined })
          }
        />
      }
      actions={
        <NewInProject
          label="New pull request"
          projects={projects}
          name={choice.name}
          onPick={(project) =>
            void navigate({
              to: "/pulls/$project/new",
              params: { project },
              search: { back: listAddress },
            })
          }
        />
      }
      views={views}
      strip={
        <>
          <PartialNotice failed={list.failed} name={choice.name} onRetry={list.retry} />
          {single && (
            <MergeStrip
              merge={merge}
              method={method}
              onMethod={setMethod}
              command={verify.data?.command}
              onSetCommand={() => dialogs.open({ kind: "edit", projectId: single })}
              onOpenPr={(number) => openPr(single, number)}
            />
          )}
        </>
      }
      search={search.q ?? ""}
      onSearch={(text) => onSearch({ q: text.trim() || undefined })}
      menus={
        <>
          <FilterMenu
            label="State"
            value={search.state ?? "open"}
            options={stateOptions}
            onValueChange={(state) => onSearch({ state: state === "open" ? undefined : state })}
          />
          <FiltersMenu
            sections={[
              ...viewSections(search, onSearch),
              ...filterSections(search, list.rows, onSearch),
            ]}
            onClear={() =>
              onSearch({
                who: undefined,
                view: undefined,
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
      {!projects.length ? (
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
        <RowsSkeleton kind="pulls" />
      ) : !shown.length ? (
        <EmptyState title={view === "needs" ? "Nothing needs you" : "No pull requests match"} />
      ) : (
        <ForgeList
          label="Pull requests"
          stale={list.stale}
          groups={groups.map((group) => ({
            id: group.id,
            label: group.label,
            count: count(group),
            headed: groups.length > 1 || group.id !== "all",
            rows: group.rows,
          }))}
          rowKey={(row) =>
            `${row.ref.repository.owner}/${row.ref.repository.name}#${row.ref.number}`
          }
          rowTitle={(row) => row.title}
          estimate={61}
          renderRow={(row, group, last) => {
            const project = list.projectOf(row);
            return (
              <PrRow
                project={project}
                projectName={single ? undefined : choice.name(project)}
                back={listAddress}
                row={row}
                step={steps.view(row, group === "merge" && single ? merge : undefined)}
                selected={group === "merge" && single !== undefined && merge.isPicked(row)}
                last={last}
              />
            );
          }}
          onMore={
            list.more
              ? () =>
                  byWork && single !== undefined
                    ? ranked.loadMore()
                    : setPaging({ key: listKey, pages: pages + 1 })
              : undefined
          }
        />
      )}
    </ListFrame>
  );
  return (
    <Screen title="Pull requests" namedByPanel>
      {rows}
    </Screen>
  );
}
