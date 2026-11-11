import { can, repositoryCapabilities } from "@ace/ui-core";
import {
  issueQuery,
  issueSortLabels,
  repositoryLabel,
  reviewSourceId,
  sameRepository,
  type IssuesSearch,
  type IssuesSort,
  type ReviewSource,
  workKey,
} from "@ace/ui-core";
import { useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { CheckIcon, RecordIcon } from "@phosphor-icons/react";
import type { ForgeIssueList, ForgeIssueRow } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Screen } from "@/features/shell/index.ts";
import { FilterMenus, isOn, type FilterSection } from "./filters-menu.tsx";
import { ForgeList } from "./forge-list.tsx";
import { IssueRow } from "./issue-row.tsx";
import { useLinkedThreads } from "./linked-threads.ts";
import { RowsSkeleton } from "./list-skeletons.tsx";
import { ListFrame } from "./list-frame.tsx";
import { useGroupCounts, useIssuePages, useListFailure } from "./lists.ts";
import { NewInProject } from "./new-in-project.tsx";
import { PartialNotice, UnlistedNotice } from "./partial-notice.tsx";
import { useIssueSources } from "./review-sources.ts";
import { useProjectChoice } from "./project-choice.ts";
import { ProjectMenu } from "./project-menu.tsx";
import { QueryField } from "./query-field.tsx";
import { issueQueryText, issueSearchOf } from "./query-text.ts";
import { ClearLine, PresetMenu, StateToggles } from "./quick-views.tsx";

const known = (value: number | undefined) => (value === undefined ? undefined : String(value));

/**
 * Each project's open issue total for the project menu: the sum over its sources' first pages,
 * left out while any of them is unread or its repositories aren't all known.
 */
function openCounts(
  sources: readonly ReviewSource[],
  firsts: ReadonlyMap<string, ForgeIssueList>,
  settled: boolean,
): Map<string, number> {
  if (!settled) return new Map();
  const counts = new Map<string, number | undefined>();
  for (const source of sources) {
    const first = firsts.get(reviewSourceId(source));
    const sofar = counts.has(source.project) ? counts.get(source.project) : 0;
    counts.set(
      source.project,
      sofar === undefined || !first ? undefined : sofar + first.counts.open,
    );
  }
  return new Map(
    [...counts].flatMap(([project, count]) => (count === undefined ? [] : [[project, count]])),
  );
}

type Preset = "assigned" | "created" | "all";
const presetPatch: Record<Preset, Partial<IssuesSearch>> = {
  assigned: { who: "assigned" },
  created: { who: "created", author: undefined },
  all: { who: undefined },
};
const cleared: Partial<IssuesSearch> = {
  state: undefined,
  who: undefined,
  author: undefined,
  labels: undefined,
  sort: undefined,
  q: undefined,
};

const unique = (values: readonly string[]) =>
  [...new Set(values)].toSorted((a, b) => a.localeCompare(b));

/** The issue box's filter menus, in GitHub's order: Author, Label, Milestone, Sort. */
function issueSections(
  search: IssuesSearch,
  rows: readonly ForgeIssueRow[],
  onSearch: (patch: Partial<IssuesSearch>) => void,
): FilterSection[] {
  const sorts = Object.keys(issueSortLabels) as IssuesSort[];
  return [
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
      onChange: (value) =>
        onSearch({
          author: value || undefined,
          ...(search.who === "created" ? { who: undefined } : {}),
        }),
    },
    {
      kind: "many",
      id: "labels",
      label: "Label",
      values: search.labels ?? [],
      choices: unique([...rows.flatMap((row) => row.labels), ...(search.labels ?? [])]).map(
        (label) => ({ value: label, label }),
      ),
      onChange: (labels) => onSearch({ labels: labels.length ? labels : undefined }),
    },
    {
      kind: "one",
      id: "sort",
      label: "Sort",
      setting: true,
      value: search.sort && search.sort !== "updated" ? search.sort : "",
      choices: sorts.map((value) => ({
        value: value === "updated" ? "" : value,
        label: issueSortLabels[value],
      })),
      onChange: (value) => onSearch({ sort: sorts.find((key) => key === value) }),
    },
  ];
}

/**
 * Issues across the main column, from every project unless some are picked, laid out as GitHub
 * lists them: the search line over one box, its header the Open / Closed toggles and the
 * filter menus, then the rows; a row opens its issue as a page. Every filter lives in the
 * address.
 */
export function IssuesPage(props: {
  search: IssuesSearch;
  onSearch(patch: Partial<IssuesSearch>): void;
}) {
  const { search, onSearch } = props;
  const choice = useProjectChoice(search);
  const projects = choice.projects;
  const query = issueQuery(search, 1);
  const listKey = JSON.stringify([projects, query]);
  const [paging, setPaging] = useState({ key: listKey, pages: 1 });
  const pages = paging.key === listKey ? paging.pages : 1;
  // Each project's issues come from every repository it uses that ace reads issues from.
  const review = useIssueSources(projects);
  const sources = review.sources;
  const list = useIssuePages(sources, query, pages);
  const failure = useListFailure(list);
  // Who the open issues concern, whatever preset is on, for the presets' counts.
  const counted = useGroupCounts(sources, {
    by: "issue-people",
    query: issueQuery({ ...search, who: undefined, state: undefined }, 1),
  }).total;
  const people = review.settled ? counted : undefined;
  const linked = useLinkedThreads().issues;
  // Totals wait for every source's first page, so a total never undercounts.
  const partial = [...list.firsts.values()].some((first) => first.incomplete || first.truncated);
  const sum = (pick: (first: ForgeIssueList) => number) => {
    if (!review.settled || partial || list.firsts.size < sources.length) return undefined;
    let total = 0;
    for (const first of list.firsts.values()) total += pick(first);
    return total;
  };
  const navigate = useNavigate();
  const listAddress = useLocation({ select: (location) => location.searchStr });
  // New issues open on a project's primary, whose read is keyed by the project alone.
  const creatable = projects.filter((id) => {
    const first = list.firsts.get(id);
    return (
      first?.canCreate &&
      can(
        repositoryCapabilities(first.repository, review.lists.get(id)?.repositories ?? []),
        "issues.write",
      )
    );
  });
  const preset: Preset = search.who === "assigned" || search.who === "created" ? search.who : "all";
  const sections = issueSections(search, list.rows, onSearch);
  const filtered =
    preset !== "all" ||
    search.state === "closed" ||
    !!search.q ||
    !!search.sort ||
    sections.some(isOn);
  const qualifiers = (patch: Partial<IssuesSearch>) =>
    issueQueryText({ ...search, ...patch, q: undefined });
  const bar = (
    <>
      <PresetMenu
        label="Views"
        value={preset}
        onValue={(next) => onSearch(presetPatch[next])}
        views={[
          { id: "assigned", label: "Assigned to you", count: known(people?.["assigned"]) },
          { id: "created", label: "Created by you", count: known(people?.["created"]) },
          { id: "all", label: "All issues", count: undefined },
        ]}
      />
      <QueryField
        label="Search issues"
        value={issueQueryText(search)}
        lineOf={(text) => issueQueryText({ ...search, ...issueSearchOf(text) })}
        settles={(text) => qualifiers(issueSearchOf(text)) === qualifiers({})}
        onApply={(text) => onSearch(text.trim() ? issueSearchOf(text) : cleared)}
      />
      <ProjectMenu
        choice={choice}
        counts={openCounts(sources, list.firsts, review.settled)}
        onPick={(next) => onSearch({ ...choice.pick(next), labels: undefined, author: undefined })}
      />
      <NewInProject
        label="New issue"
        projects={creatable}
        name={choice.name}
        onPick={(project) =>
          void navigate({
            to: "/issues/$project/new",
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
        value={search.state ?? "open"}
        onValue={(next) => onSearch({ state: next === "open" ? undefined : next })}
        views={[
          {
            id: "open",
            label: "Open",
            count: known(sum((first) => first.counts.open)),
            icon: <RecordIcon aria-hidden size={16} />,
          },
          {
            id: "closed",
            label: "Closed",
            count: known(sum((first) => first.counts.closed)),
            icon: <CheckIcon aria-hidden size={16} />,
          },
        ]}
      />
      <FilterMenus sections={sections} />
    </>
  );
  return (
    <Screen title="Issues" namedByPanel>
      <ListFrame
        kind="issues"
        address={listAddress}
        ready={list.rows.length > 0}
        bar={bar}
        strip={
          <>
            {filtered && <ClearLine onClear={() => onSearch(cleared)} />}
            <PartialNotice
              failed={list.failed}
              name={(source) =>
                source.shown
                  ? choice.one
                    ? repositoryLabel(source.shown)
                    : `${choice.name(source.project)}'s ${repositoryLabel(source.shown)}`
                  : choice.name(source.project)
              }
              onRetry={list.retry}
            />
            <UnlistedNotice projects={review.unlisted} name={choice.name} />
          </>
        }
        header={header}
      >
        {!projects.length ? (
          choice.loaded && (
            <EmptyState
              title="No projects yet"
              description="Add a project with a GitHub remote to see its issues."
            />
          )
        ) : list.error && !list.first ? (
          <EmptyState
            title="Couldn't load issues"
            description={failure}
            action={
              <Button size="sm" onClick={list.retry}>
                Try again
              </Button>
            }
          />
        ) : list.loading ? (
          <RowsSkeleton label="issues" />
        ) : !list.rows.length ? (
          <EmptyState title="No results matched your search." />
        ) : (
          <ForgeList
            label="Issues"
            stale={list.stale}
            rows={list.rows}
            rowKey={(row) =>
              `${row.ref.repository.owner}/${row.ref.repository.name}#${row.ref.number}`
            }
            rowTitle={(row) => row.title}
            estimate={57}
            renderRow={(row, _group, last) => {
              const project = list.projectOf(row);
              return (
                <IssueRow
                  project={project}
                  projectName={choice.one ? undefined : choice.name(project)}
                  repositoryName={
                    review.several.has(project) ? repositoryLabel(row.ref.repository) : undefined
                  }
                  otherRepository={
                    !sameRepository(
                      row.ref.repository,
                      review.primary.get(project) ?? row.ref.repository,
                    )
                  }
                  back={listAddress}
                  row={row}
                  thread={linked.get(workKey(row.ref.repository, row.ref.number))}
                  last={last}
                />
              );
            }}
            onMore={list.more ? () => setPaging({ key: listKey, pages: pages + 1 }) : undefined}
          />
        )}
      </ListFrame>
    </Screen>
  );
}
