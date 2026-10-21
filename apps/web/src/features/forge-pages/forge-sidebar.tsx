import { useState } from "react";
import { PlusIcon } from "@phosphor-icons/react";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { SearchField } from "@/components/search-field.tsx";
import { FilterMenu } from "@/components/ui/filter-menu.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Tabs, TabsList, TabsTab } from "@/components/ui/tabs.tsx";
import { ViewSidebar } from "@/features/shell/index.ts";
import { useDebouncedValue } from "@/lib/debounced.ts";
import { useForgeBrowse } from "./browse-context.tsx";
import {
  issuePeople,
  issuePeopleLabels,
  issueQuery,
  issueStateLabels,
  issueStateOptions,
  prPeople,
  prPeopleLabels,
  prQuery,
  prStateLabels,
  prStateOptions,
  type ForgeKind,
} from "./filters.ts";
import { ForgeList } from "./forge-list.tsx";
import { useIssueListPage, usePrListPage } from "./lists.ts";
import { NewIssueDialog } from "./new-issue-dialog.tsx";

/** GitHub's search allows 30 requests a minute: let typing settle before asking. */
const searchSettleMs = 300;

export function forgeKind(pathname: string): ForgeKind {
  return pathname.startsWith("/issues") ? "issues" : "pulls";
}

/** The filter menus for the list on show, labelled with GitHub's counts for each state. */
function Filters(props: { kind: ForgeKind; project: string; search: string }) {
  const browse = useForgeBrowse();
  const { filters } = browse;
  // The first page is the list's own read, so its counts cost nothing more.
  const prs = usePrListPage(
    props.kind === "pulls" ? props.project : undefined,
    prQuery(filters, props.search, 1),
  ).data;
  const issues = useIssueListPage(
    props.kind === "issues" ? props.project : undefined,
    issueQuery(filters, props.search, 1),
  ).data;
  if (props.kind === "pulls")
    return (
      <>
        <FilterMenu
          label="State"
          value={filters.prState}
          options={prStateOptions(prs?.counts)}
          onValueChange={(prState) => browse.change({ prState })}
        />
        <FilterMenu
          label="People"
          value={filters.prPeople}
          options={prPeople.map((value) => ({ value, label: prPeopleLabels[value] }))}
          onValueChange={(value) => browse.change({ prPeople: value })}
        />
      </>
    );
  return (
    <>
      <FilterMenu
        label="State"
        value={filters.issueState}
        options={issueStateOptions(issues?.counts)}
        onValueChange={(issueState) => browse.change({ issueState })}
      />
      <FilterMenu
        label="People"
        value={filters.issuePeople}
        options={issuePeople.map((value) => ({ value, label: issuePeopleLabels[value] }))}
        onValueChange={(value) => browse.change({ issuePeople: value })}
      />
    </>
  );
}

function NewIssue(props: { project: string; search: string }) {
  const browse = useForgeBrowse();
  const list = useIssueListPage(props.project, issueQuery(browse.filters, props.search, 1)).data;
  const [open, setOpen] = useState(false);
  if (!list?.canCreate) return null;
  return (
    <>
      <IconButton icon={PlusIcon} label="New issue" onClick={() => setOpen(true)} />
      <NewIssueDialog
        project={props.project}
        repository={list.repository}
        open={open}
        onOpenChange={setOpen}
      />
    </>
  );
}

/**
 * The Pull requests view's list: its two tabs, the project and filters, a search, and the rows.
 * Choosing a project or a tab goes back to that list's start.
 */
export function ForgeSidebar() {
  const browse = useForgeBrowse();
  const navigate = useNavigate();
  const kind = forgeKind(useLocation({ select: (location) => location.pathname }));
  const text = browse.search[kind];
  const search = useDebouncedValue(text.trim(), searchSettleMs);
  const project = browse.project;
  const { filters } = browse;
  const listKey = JSON.stringify([
    kind,
    project,
    search,
    kind === "pulls"
      ? [filters.prState, filters.prPeople]
      : [filters.issueState, filters.issuePeople],
  ]);
  const none = search
    ? `Nothing matches "${search}".`
    : kind === "pulls"
      ? `No ${prStateLabels[filters.prState].toLowerCase()} pull requests.`
      : `No ${issueStateLabels[filters.issueState].toLowerCase()} issues.`;
  return (
    <ViewSidebar
      toolbar={
        <div className="flex shrink-0 flex-col gap-1.5 pr-2.5 pb-2 pl-3">
          <div className="flex h-9 items-center gap-1 pt-1">
            <Tabs
              value={kind}
              onValueChange={(value) =>
                void navigate({ to: value === "issues" ? "/issues" : "/pulls" })
              }
            >
              <TabsList aria-label="Pull requests and issues">
                <TabsTab value="pulls">Pull requests</TabsTab>
                <TabsTab value="issues">Issues</TabsTab>
              </TabsList>
            </Tabs>
            <span className="flex-1" />
            {kind === "issues" && project && <NewIssue project={project} search={search} />}
          </div>
          {project && (
            <div className="-ml-2 flex min-w-0 items-center gap-0.5">
              {browse.projects.length > 1 ? (
                <FilterMenu
                  label="Project"
                  value={project}
                  options={browse.projects.map((id) => ({
                    value: id,
                    label: browse.projectName(id),
                  }))}
                  onValueChange={(next) => {
                    browse.change({ project: next });
                    void navigate({ to: kind === "issues" ? "/issues" : "/pulls" });
                  }}
                />
              ) : (
                <span className="truncate px-2 text-ui text-muted-foreground">
                  {browse.projectName(project)}
                </span>
              )}
              <span className="flex-1" />
              <Filters kind={kind} project={project} search={search} />
            </div>
          )}
          {project && (
            <SearchField
              label={kind === "pulls" ? "Search pull requests" : "Search issues"}
              placeholder="Search"
              value={text}
              onValueChange={(value) => browse.setSearch(kind, value)}
              className="bg-sidebar-accent"
            />
          )}
        </div>
      }
    >
      {project ? (
        <ForgeList
          key={listKey}
          kind={kind}
          project={project}
          filters={filters}
          search={search}
          none={none}
        />
      ) : browse.projectsLoaded ? (
        <EmptyState variant="inline" title="Add a project to see its pull requests and issues." />
      ) : null}
    </ViewSidebar>
  );
}
