import {
  issueQuery,
  issueSortLabels,
  type IssuesSearch,
  type IssuesSort,
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
import { primarySources, useGroupCounts, useIssuePages, useListFailure } from "./lists.ts";
import { NewInProject } from "./new-in-project.tsx";
import { PartialNotice } from "./partial-notice.tsx";
import { useProjectChoice } from "./project-choice.ts";
import { ProjectMenu } from "./project-menu.tsx";
import { QueryField } from "./query-field.tsx";
import { issueQueryText, issueSearchOf } from "./query-text.ts";
import { ClearLine, PresetMenu, StateToggles } from "./quick-views.tsx";

const known = (value: number | undefined) => (value === undefined ? undefined : String(value));

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
  const list = useIssuePages(projects, query, pages);
  const failure = useListFailure(list);
  // Who the open issues concern, whatever preset is on, for the presets' counts.
  const people = useGroupCounts(primarySources(projects), {
    by: "issue-people",
    query: issueQuery({ ...search, who: undefined, state: undefined }, 1),
  }).total;
  const linked = useLinkedThreads().issues;
  const sum = (pick: (first: ForgeIssueList) => number) => {
    if (list.firsts.size < projects.length) return undefined;
    let total = 0;
    for (const first of list.firsts.values()) total += pick(first);
    return total;
  };
  const navigate = useNavigate();
  const listAddress = useLocation({ select: (location) => location.searchStr });
  const creatable = projects.filter((id) => list.firsts.get(id)?.canCreate);
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
        counts={new Map([...list.firsts].map(([id, first]) => [id, first.counts.open]))}
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
              name={(source) => choice.name(source.project)}
              onRetry={list.retry}
            />
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
