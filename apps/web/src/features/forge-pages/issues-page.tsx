import {
  groupIssues,
  issueQuery,
  issueSortLabels,
  type IssuesSearch,
  type IssuesSort,
  workKey,
} from "@ace/ui-core";
import { useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import type { ForgeIssueList, ForgeIssueRow } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { FilterMenu } from "@/components/ui/filter-menu.tsx";
import { Screen } from "@/features/shell/index.ts";
import { FiltersMenu, type FilterSection } from "./filters-menu.tsx";
import { ForgeList } from "./forge-list.tsx";
import { IssueRow } from "./issue-row.tsx";
import { useLinkedThreads } from "./linked-threads.ts";
import { RowsSkeleton } from "./list-skeletons.tsx";
import { ListFrame } from "./list-frame.tsx";
import { useGroupCounts, useIssuePages } from "./lists.ts";
import { NewInProject } from "./new-in-project.tsx";
import { PartialNotice } from "./partial-notice.tsx";
import { useProjectChoice } from "./project-choice.ts";
import { ProjectMenu } from "./project-menu.tsx";
import { countWords } from "./quick-views.tsx";

const unique = (values: readonly string[]) =>
  [...new Set(values)].toSorted((a, b) => a.localeCompare(b));

/**
 * Who the list concerns and its order, first in the Filters menu: who counts as a filter that
 * is on; sort is the view's setting.
 */
function viewSections(
  search: IssuesSearch,
  onSearch: (patch: Partial<IssuesSearch>) => void,
): FilterSection[] {
  const sorts = Object.keys(issueSortLabels) as IssuesSort[];
  return [
    {
      kind: "one",
      id: "who",
      label: "Involvement",
      value: search.who && search.who !== "all" ? search.who : "",
      choices: [
        { value: "", label: "Everyone" },
        { value: "assigned", label: "Assigned" },
        { value: "created", label: "Created" },
      ],
      onChange: (value) =>
        onSearch({ who: value === "assigned" || value === "created" ? value : undefined }),
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

function filterSections(
  search: IssuesSearch,
  rows: readonly ForgeIssueRow[],
  onSearch: (patch: Partial<IssuesSearch>) => void,
): FilterSection[] {
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
 * Issues across the main column, from every project unless some are picked, grouped as
 * assigned to you, opened by you and the rest; a row opens its issue as a page. Every filter
 * lives in the address.
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
  const totals = useGroupCounts(projects, { by: "issue-people", query }).total;
  const linked = useLinkedThreads().issues;
  const groups = groupIssues(list.rows, list.first?.viewer);
  const sum = (pick: (first: ForgeIssueList) => number) => {
    if (list.firsts.size < projects.length) return undefined;
    let total = 0;
    for (const first of list.firsts.values()) total += pick(first);
    return total;
  };
  const navigate = useNavigate();
  const listAddress = useLocation({ select: (location) => location.searchStr });
  const creatable = projects.filter((id) => list.firsts.get(id)?.canCreate);
  const rows = (
    <ListFrame
      kind="issues"
      address={listAddress}
      ready={list.rows.length > 0}
      lead={
        <ProjectMenu
          choice={choice}
          counts={new Map([...list.firsts].map(([id, first]) => [id, first.counts.open]))}
          onPick={(next) =>
            onSearch({ ...choice.pick(next), labels: undefined, author: undefined })
          }
        />
      }
      search={search.q ?? ""}
      onSearch={(text) => onSearch({ q: text.trim() || undefined })}
      strip={<PartialNotice failed={list.failed} name={choice.name} onRetry={list.retry} />}
      actions={
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
      }
      menus={
        <>
          <FilterMenu
            label="State"
            value={search.state ?? "open"}
            options={[
              { value: "open" as const, label: "Open", count: sum((first) => first.counts.open) },
              {
                value: "closed" as const,
                label: "Closed",
                count: sum((first) => first.counts.closed),
              },
            ]}
            onValueChange={(state) => onSearch({ state: state === "open" ? undefined : state })}
          />
          <FiltersMenu
            sections={[
              ...viewSections(search, onSearch),
              ...filterSections(search, list.rows, onSearch),
            ]}
            onClear={() => onSearch({ who: undefined, author: undefined, labels: undefined })}
          />
        </>
      }
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
          description={list.error.message}
          action={
            <Button size="sm" onClick={list.retry}>
              Try again
            </Button>
          }
        />
      ) : list.loading ? (
        <RowsSkeleton kind="issues" />
      ) : !list.rows.length ? (
        <EmptyState title="No issues match" />
      ) : (
        <ForgeList
          label="Issues"
          stale={list.stale}
          groups={groups.map((group) => ({
            id: group.id,
            label: group.label,
            count: countWords(group.rows.length, totals?.[group.id], !list.more),
            headed: group.id !== "all",
            rows: group.rows,
          }))}
          rowKey={(row) =>
            `${row.ref.repository.owner}/${row.ref.repository.name}#${row.ref.number}`
          }
          rowTitle={(row) => row.title}
          estimate={61}
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
  );
  return (
    <Screen title="Issues" namedByPanel>
      {rows}
    </Screen>
  );
}
