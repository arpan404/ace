import {
  groupByWork,
  prQuery,
  repositoryLabel,
  reviewSourceId,
  type ReviewSource,
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
import { repositoryParam } from "@/lib/pull-request-route.ts";
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
import { useGroupCounts, useListFailure, usePrPages } from "./lists.ts";
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
import { useReviewSources } from "./review-sources.ts";
import { ClearLine, countWords, PresetMenu, StateToggles } from "./quick-views.tsx";

const noRuns: readonly VerifyRun[] = [];

/**
 * Each project's open total for the project menu: the sum over its repositories' first pages,
 * left out while any of them is unread, incomplete or truncated.
 */
function projectOpenCounts(
  sources: readonly ReviewSource[],
  firsts: ReadonlyMap<string, ForgePrList>,
  settled: boolean,
): Map<string, number> {
  const counts = new Map<string, number | undefined>();
  if (!settled) return new Map();
  for (const source of sources) {
    const first = firsts.get(reviewSourceId(source));
    const known = counts.has(source.project) ? counts.get(source.project) : 0;
    counts.set(
      source.project,
      known === undefined || !first || first.incomplete || first.truncated
        ? undefined
        : known + first.counts.open + first.counts.draft,
    );
  }
  return new Map(
    [...counts].flatMap(([project, count]) => (count === undefined ? [] : [[project, count]])),
  );
}
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
  // Each project's reviews come from every repository it uses (ADR 0116).
  const review = useReviewSources(projects);
  const sources = review.sources;
  const listed = usePrPages(sources, query, pages);
  // Ranking reads one repository: a project listing several is read newest first, like several
  // projects are.
  const rankedActive =
    byWork && single !== undefined && review.settled && !review.several.has(single);
  const ranked = useReadyPages(single, search, rankedActive);
  const useRanked = rankedActive && ranked.error === undefined;
  const list = useRanked ? ranked : listed;
  const failure = useListFailure(list);
  const peopleQuery = prQuery({ ...search, who: undefined }, 1);
  const people = useGroupCounts(open ? sources : [], { by: "pr-people", query: peopleQuery });
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
  const partial = (first: ForgePrList) => first.incomplete || first.truncated;
  const incomplete = [...list.firsts.values()].some(partial);
  const complete = !list.more && !incomplete && review.settled;
  const sum = (pick: (counts: ForgePrList["counts"]) => number) => {
    if (!review.settled || incomplete || list.firsts.size < sources.length) return undefined;
    let total = 0;
    for (const first of list.firsts.values()) total += pick(first.counts);
    return total;
  };
  const openCounts = projectOpenCounts(sources, list.firsts, review.settled);
  const peopleTotal = review.settled ? people.total : undefined;
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
  // A merge run's PR opens in its own repository, never a same-numbered one on another host.
  const openPr = (project: string, number: number) => {
    const target = merge.run?.target;
    const pr =
      target?.kind === "merge"
        ? target.prs.find((each) => each.pr.number === number)?.pr
        : target?.pr.pr.number === number
          ? target.pr.pr
          : undefined;
    void navigate({
      to: "/pulls/$project/$number",
      params: { project, number: String(number) },
      search: { back: listAddress, ...(pr ? { repo: repositoryParam(pr.repository) } : {}) },
    });
  };
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
            <PartialNotice
              failed={list.failed}
              name={(source) =>
                source.shown
                  ? single
                    ? repositoryLabel(source.shown)
                    : `${choice.name(source.project)}'s ${repositoryLabel(source.shown)}`
                  : choice.name(source.project)
              }
              onRetry={list.retry}
            />
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
            description={failure}
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
                  repositoryName={
                    review.several.has(project) ? repositoryLabel(row.ref.repository) : undefined
                  }
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
