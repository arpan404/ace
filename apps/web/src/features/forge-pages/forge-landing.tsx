import { GitPullRequestIcon } from "@phosphor-icons/react";
import { Navigate } from "@tanstack/react-router";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Screen, ViewListPage } from "@/features/shell/index.ts";
import { useDebouncedValue } from "@/lib/debounced.ts";
import { useForgeBrowse } from "./browse-context.tsx";
import { issueQuery, prQuery, type ForgeKind } from "./filters.ts";
import { useIssueListPage, usePrListPage } from "./lists.ts";

const titles: Record<ForgeKind, string> = { pulls: "Pull requests", issues: "Issues" };

/** The first row of the list on show, once it has loaded. */
function useFirst(kind: ForgeKind) {
  const browse = useForgeBrowse();
  const search = useDebouncedValue(browse.search[kind].trim(), 300);
  const prs = usePrListPage(
    kind === "pulls" ? browse.project : undefined,
    prQuery(browse.filters, search, 1),
  );
  const issues = useIssueListPage(
    kind === "issues" ? browse.project : undefined,
    issueQuery(browse.filters, search, 1),
  );
  const query = kind === "pulls" ? prs : issues;
  return {
    project: browse.project,
    projectsLoaded: browse.projectsLoaded,
    first: query.isPlaceholderData ? undefined : query.data?.items[0]?.ref.number,
    settled: !!query.data && !query.isPlaceholderData,
    error: query.isError ? query.error : undefined,
  };
}

/**
 * A list's start. A narrow window shows the list as the page; a wide one, where the list is in
 * the sidebar, opens its first row, or says why there is none.
 */
export function ForgeLanding(props: { kind: ForgeKind }) {
  const state = useFirst(props.kind);
  const title = titles[props.kind];
  const fallback =
    state.project && state.first !== undefined ? (
      <Navigate
        to={props.kind === "pulls" ? "/pulls/$project/$number" : "/issues/$project/$number"}
        params={{ project: state.project, number: String(state.first) }}
        replace
      />
    ) : (
      <Screen title={title}>
        {state.error ? (
          <EmptyState
            icon={GitPullRequestIcon}
            heading
            title={`${title} unavailable`}
            description={state.error.message}
          />
        ) : !state.project && state.projectsLoaded ? (
          <EmptyState
            icon={GitPullRequestIcon}
            heading
            title="No projects yet"
            description="Add a project with a GitHub remote to see its pull requests and issues."
          />
        ) : state.settled ? (
          <EmptyState icon={GitPullRequestIcon} heading title={`No ${title.toLowerCase()}`} />
        ) : null}
      </Screen>
    );
  return <ViewListPage title={title} fallback={fallback} />;
}
