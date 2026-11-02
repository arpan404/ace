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
import { PencilSimpleIcon, RecordIcon, UserIcon, UsersIcon } from "@phosphor-icons/react";
import type { ForgeIssueRow } from "@ace/protocol";
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
import { projectSection, useProjectChoice, type ProjectChoice } from "./project-choice.ts";

const groupIcons = {
  assigned: UserIcon,
  created: PencilSimpleIcon,
  others: UsersIcon,
  all: RecordIcon,
} as const;
const unique = (values: readonly string[]) =>
  [...new Set(values)].toSorted((a, b) => a.localeCompare(b));

/**
 * Who the list concerns, its order and its project, first in the Filters menu: who counts as a
 * filter that is on; sort and project are the view's settings.
 */
function viewSections(
  search: IssuesSearch,
  onSearch: (patch: Partial<IssuesSearch>) => void,
  choice: ProjectChoice,
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
    ...projectSection(choice, (project) =>
      onSearch({ project, labels: undefined, author: undefined }),
    ),
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
 * A project's issues across the main column, grouped as assigned to you, opened by you and the
 * rest; a row opens its issue as a page. Every filter lives in the address.
 */
export function IssuesPage(props: {
  search: IssuesSearch;
  onSearch(patch: Partial<IssuesSearch>): void;
}) {
  const { search, onSearch } = props;
  const choice = useProjectChoice(search.project);
  const project = choice.project;
  const query = issueQuery(search, 1);
  const listKey = JSON.stringify([project, query]);
  const [paging, setPaging] = useState({ key: listKey, pages: 1 });
  const pages = paging.key === listKey ? paging.pages : 1;
  const list = useIssuePages(project, query, pages);
  const totals = useGroupCounts(project, { by: "issue-people", query }).data;
  const linked = useLinkedThreads().issues;
  const groups = groupIssues(list.rows, list.first?.viewer);
  const counts = list.first?.counts;
  const navigate = useNavigate();
  const listAddress = useLocation({ select: (location) => location.searchStr });
  const rows = (
    <ListFrame
      kind="issues"
      address={listAddress}
      ready={list.rows.length > 0}
      search={search.q ?? ""}
      onSearch={(text) => onSearch({ q: text.trim() || undefined })}
      actions={
        project && list.first?.canCreate ? (
          <Button
            size="sm"
            onClick={() =>
              void navigate({
                to: "/issues/$project/new",
                params: { project },
                search: { back: listAddress },
              })
            }
          >
            New issue
          </Button>
        ) : null
      }
      menus={
        <>
          <FilterMenu
            label="State"
            value={search.state ?? "open"}
            options={[
              { value: "open" as const, label: "Open", count: counts?.open },
              { value: "closed" as const, label: "Closed", count: counts?.closed },
            ]}
            onValueChange={(state) => onSearch({ state: state === "open" ? undefined : state })}
          />
          <FiltersMenu
            sections={[
              ...viewSections(search, onSearch, choice),
              ...filterSections(search, list.rows, onSearch),
            ]}
            onClear={() => onSearch({ who: undefined, author: undefined, labels: undefined })}
          />
        </>
      }
    >
      {!project ? (
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
            icon: groupIcons[group.id as keyof typeof groupIcons] ?? UsersIcon,
            count: totals?.[group.id],
            headed: group.id !== "all",
            rows: group.rows,
          }))}
          rowKey={(row) => String(row.ref.number)}
          rowTitle={(row) => row.title}
          estimate={61}
          renderRow={(row, _group, last) => (
            <IssueRow
              project={project}
              back={listAddress}
              row={row}
              thread={linked.get(workKey(row.ref.repository, row.ref.number))}
              last={last}
            />
          )}
          onMore={list.more ? () => setPaging({ key: listKey, pages: pages + 1 }) : undefined}
        />
      )}
    </ListFrame>
  );
  return (
    <Screen title="Issues" namedByPanel crumb={project ? choice.name(project) : undefined}>
      {rows}
    </Screen>
  );
}
