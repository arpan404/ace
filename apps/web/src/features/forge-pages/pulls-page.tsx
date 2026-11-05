import {
  groupByWork,
  prQuery,
  sortPrs,
  workKey,
  type PullsSearch,
  type PullsSort,
} from "@ace/ui-core";
import { useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { GitMergeIcon, GitPullRequestIcon, XCircleIcon } from "@phosphor-icons/react";
import type { ForgePrList, ForgePrRow, VerifyRun } from "@ace/protocol";
import { useVerifyRuns } from "@/lib/verify.ts";
import { useMergeMethod } from "@/features/forge/index.ts";
import { useProjectDialogs } from "@/features/projects/index.ts";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Screen } from "@/features/shell/index.ts";
import { FilterMenus, isOn } from "./filters-menu.tsx";
import { ForgeList } from "./forge-list.tsx";
import { useLinkedThreads } from "./linked-threads.ts";
import { RowsSkeleton } from "./list-skeletons.tsx";
import { ListFrame } from "./list-frame.tsx";
import { useGroupCounts, usePrPages } from "./lists.ts";
import { NewInProject } from "./new-in-project.tsx";
import { PrRow } from "./pr-row.tsx";
import { pullSections } from "./pull-filters.ts";
import { prQueryText, prSearchOf } from "./query-text.ts";
import { QueryField } from "./query-field.tsx";
import { useReadyPages } from "./ready-pages.ts";
import { useMergeRun } from "./merge-run.ts";
import { MergeStrip } from "./merge-strip.tsx";
import { useRowSteps } from "./row-steps.ts";
import { useProjectChoice } from "./project-choice.ts";
import { ProjectMenu } from "./project-menu.tsx";
import { PartialNotice } from "./partial-notice.tsx";
import { ClearLine, countWords, PresetMenu, StateToggles } from "./quick-views.tsx";

const noRuns: readonly VerifyRun[] = [];
const noRows: readonly ForgePrRow[] = [];

const known = (value: number | undefined) => (value === undefined ? undefined : String(value));

type Preset = "needs" | "review" | "yours" | "all";
type State = "open" | "merged" | "closed";

/** The preset the address asks for: who the list concerns. */
function presetOf(search: PullsSearch): Preset {
  if (search.view === "needs") return "needs";
  if (search.who === "reviewing") return "review";
  if (search.who === "authored") return "yours";
  return "all";
}
const presetPatch: Record<Preset, Partial<PullsSearch>> = {
  needs: { state: undefined, view: "needs", who: undefined, author: undefined },
  review: { view: undefined, who: "reviewing" },
  yours: { view: undefined, who: "authored", author: undefined },
  all: { view: undefined, who: undefined },
};
/** Every filter back to the list as it starts. */
const cleared: Partial<PullsSearch> = {
  state: undefined,
  view: undefined,
  who: undefined,
  draft: undefined,
  review: undefined,
  checks: undefined,
  author: undefined,
  labels: undefined,
  sort: undefined,
  q: undefined,
};

/**
 * Pull requests across the main column, from every project unless some are picked, laid out as
 * GitHub lists them: the search line over one box, its header the Open / Merged / Closed
 * toggles and the filter menus, then the rows. Open ones sort by who has the next move unless
 * another sort is picked. Every filter lives in the address.
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
  const rankedActive = byWork && single !== undefined;
  const ranked = useReadyPages(single, search, rankedActive);
  const useRanked = rankedActive && ranked.error === undefined;
  const list = useRanked ? ranked : listed;
  const peopleQuery = prQuery({ ...search, who: undefined }, 1);
  const people = useGroupCounts(open ? projects : [], { by: "pr-people", query: peopleQuery });
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
  const preset = presetOf(search);
  const needsYou = list.rows.filter((row) => steps.groupOf(row) === "you");
  const shown = open && preset === "needs" ? needsYou : list.rows;
  const rows: ForgePrRow[] = byWork
    ? groupByWork(shown, (row) => steps.stepOf(row).step, steps.threadOf).flatMap(
        (group) => group.rows,
      )
    : sortPrs(shown, sort === "ready" ? "updated" : sort);
  // Ready rows can be picked for one verified merge, with one project shown.
  const mergeable = (row: ForgePrRow) =>
    byWork && single !== undefined && steps.groupOf(row) === "merge";
  const merge = useMergeRun(single ?? "", single ? rows.filter(mergeable) : noRows, runs);
  const [method, setMethod] = useMergeMethod(single ?? "");
  const navigate = useNavigate();
  const dialogs = useProjectDialogs();
  const incomplete = [...list.firsts.values()].some((first) => first.incomplete || first.truncated);
  const complete = !list.more && !incomplete;
  const sum = (pick: (counts: ForgePrList["counts"]) => number) => {
    if (list.firsts.size < projects.length) return undefined;
    if (incomplete) return undefined;
    let total = 0;
    for (const first of list.firsts.values()) total += pick(first.counts);
    return total;
  };
  const openCounts = new Map(
    [...list.firsts]
      .filter(([, first]) => !first.incomplete && !first.truncated)
      .map(([id, first]) => [id, first.counts.open + first.counts.draft]),
  );
  const peopleTotal = people.total;
  const allOpen = incomplete
    ? undefined
    : peopleTotal
      ? Object.values(peopleTotal).reduce((a, b) => a + b, 0)
      : sum((c) => c.open + c.draft);
  const state: State | undefined = search.state === "all" ? undefined : (search.state ?? "open");
  const sections = pullSections(search, list.rows, onSearch);
  const filtered =
    preset !== "all" ||
    !!search.q ||
    !!search.draft ||
    !!search.sort ||
    (search.state !== undefined && search.state !== "open") ||
    sections.some(isOn);
  const line = prQueryText(search);
  const lineOf = (text: string) => prQueryText({ ...search, ...prSearchOf(text) });
  const qualifiers = (patch: Partial<PullsSearch>) =>
    prQueryText({ ...search, ...patch, q: undefined });
  const openPr = (project: string, number: number) =>
    void navigate({
      to: "/pulls/$project/$number",
      params: { project, number: String(number) },
      search: { back: listAddress },
    });
  const bar = (
    <>
      <PresetMenu
        label="Views"
        value={preset}
        onValue={(next) => onSearch(presetPatch[next])}
        views={[
          {
            id: "needs",
            label: "Needs you",
            count: open ? countWords(needsYou.length, undefined, complete) : undefined,
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
          { id: "all", label: "All pull requests", count: undefined },
        ]}
      />
      <QueryField
        label="Search pull requests"
        value={line}
        lineOf={lineOf}
        settles={(text) => qualifiers(prSearchOf(text)) === qualifiers({})}
        onApply={(text) => onSearch(text.trim() ? prSearchOf(text) : cleared)}
      />
      <ProjectMenu
        choice={choice}
        counts={openCounts}
        onPick={(next) => onSearch({ ...choice.pick(next), labels: undefined, author: undefined })}
      />
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
    </>
  );
  const header = (
    <>
      <StateToggles
        label="State"
        value={state}
        onValue={(next) =>
          onSearch({
            state: next === "open" ? undefined : next,
            ...(next !== "open" && search.view === "needs" ? { view: undefined } : {}),
          })
        }
        views={[
          {
            id: "open",
            label: "Open",
            count: known(allOpen),
            icon: <GitPullRequestIcon aria-hidden size={16} />,
          },
          {
            id: "merged",
            label: "Merged",
            count: known(sum((c) => c.merged)),
            icon: <GitMergeIcon aria-hidden size={16} />,
          },
          {
            id: "closed",
            label: "Closed",
            count: known(sum((c) => c.closed)),
            icon: <XCircleIcon aria-hidden size={16} />,
          },
        ]}
      />
      <FilterMenus sections={sections} />
    </>
  );
  return (
    <Screen title="Pull requests" namedByPanel>
      <ListFrame
        kind="pulls"
        address={listAddress}
        ready={rows.length > 0}
        bar={bar}
        strip={
          <>
            {filtered && <ClearLine onClear={() => onSearch(cleared)} />}
            <PartialNotice failed={list.failed} name={choice.name} onRetry={list.retry} />
            {incomplete && !list.loading && !(list.error && !list.first) && (
              <div
                role="status"
                className="flex min-h-9 min-w-0 items-center gap-1 border-t border-border py-1 text-ui text-muted-foreground"
              >
                <span className="min-w-0 truncate">Some totals are incomplete.</span>
              </div>
            )}
            {byWork && single && ranked.rankingError && (
              <div
                role="status"
                aria-label="Pull request ranking"
                className="flex flex-wrap items-center gap-2 py-2 text-ui text-muted-foreground"
              >
                <span>
                  {ranked.unranked
                    ? "Couldn't rank pull requests. Showing the most recently updated ones."
                    : "Couldn't rank more pull requests."}
                </span>
                <Button size="xs" variant="ghost" onClick={ranked.retry}>
                  Try again
                </Button>
              </div>
            )}
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
        header={header}
      >
        {!projects.length ? (
          choice.loaded && (
            <EmptyState
              title="No projects yet"
              description="Add a project with a remote to see its pull requests."
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
          <RowsSkeleton label="pull requests" />
        ) : !rows.length ? (
          <EmptyState
            title={preset === "needs" ? "Nothing needs you" : "No results matched your search."}
          />
        ) : (
          <ForgeList
            label="Pull requests"
            stale={list.stale}
            rows={rows}
            rowKey={(row) => workKey(row.ref.repository, row.ref.number)}
            rowTitle={(row) => row.title}
            estimate={57}
            renderRow={(row, _group, last) => {
              const project = list.projectOf(row);
              const picking = mergeable(row);
              return (
                <PrRow
                  project={project}
                  projectName={single ? undefined : choice.name(project)}
                  back={listAddress}
                  row={row}
                  step={steps.view(row, picking ? merge : undefined)}
                  selected={picking && merge.isPicked(row)}
                  last={last}
                />
              );
            }}
            onMore={
              list.more
                ? () =>
                    useRanked ? ranked.loadMore() : setPaging({ key: listKey, pages: pages + 1 })
                : undefined
            }
          />
        )}
      </ListFrame>
    </Screen>
  );
}
