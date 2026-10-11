import { useState, useRef, useLayoutEffect } from "react";
import type { ForgeIssueSearch } from "@ace/protocol";
import { issueFromUrl, prRepository } from "@ace/forge/pr-reference";
import { useRegisteredProjects } from "@/lib/projects.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { Screen } from "@/features/shell/index.ts";
import { Input } from "@/components/ui/input.tsx";
import { Button } from "@/components/ui/button.tsx";
import { QueryState } from "./query-state.tsx";
import { IssueDetail } from "./issue-detail.tsx";
import { IssueEditor } from "./issue-editor.tsx";
import { readForge } from "./source.ts";
import { useQueryClient } from "@tanstack/react-query";
import { refreshIssueLists } from "./issue-cache.ts";

export interface IssueLocation extends ForgeIssueSearch {
  project: string;
  repo: string;
  number?: number | undefined;
}
export function IssueScreen(props: {
  location: IssueLocation;
  onLocation(location: IssueLocation): void;
}) {
  const projects = useRegisteredProjects();
  const cache = useQueryClient();
  const location = props.location;
  const workspaceId = location.project || projects.ids[0] || "";
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const scroller = useRef<HTMLDivElement>(null);
  const scroll = useRef(0);
  const repository = location.repo
    ? prRepository(location.repo, {
        forge: "github",
        host: "github.com",
        owner: "unused",
        name: "unused",
      })
    : undefined;
  const query = useDaemonQuery({
    queryKey: [
      "forge",
      workspaceId,
      repository,
      "issueList",
      location.state,
      location.search,
      location.labels,
      location.author,
      location.assignee,
      location.milestone,
      location.sort,
      location.order,
      location.page,
    ],
    enabled: Boolean(workspaceId) && !location.number,
    retry: false,
    staleTime: 30000,
    refetchOnReconnect: "always",
    read: async (client, signal) => {
      const value = await readForge(
        client,
        { op: "forge.issue.list", workspaceId, repository, query: location },
        signal,
      );
      if (value.resource !== "issueList") throw new Error("No issue list.");
      return value.value;
    },
  });
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = location.number ? 0 : scroll.current;
  }, [location.number]);
  const change = (next: Partial<IssueLocation>) =>
    props.onLocation({ ...location, project: workspaceId, ...next });
  const open = (number: number, repo = location.repo) => {
    if (scroller.current) scroll.current = scroller.current.scrollTop;
    change({ number, repo });
  };
  return (
    <Screen title="Issues">
      <div ref={scroller} className="h-full overflow-auto">
        <div className="mx-auto max-w-[1040px] space-y-6 px-4 py-6 sm:px-8">
          <div className="flex flex-wrap gap-3">
            <label className="text-sm">
              Project{" "}
              <select
                aria-label="Issue repository project"
                value={workspaceId}
                className="bg-input p-1 focus-ring"
                onChange={(e) => {
                  scroll.current = 0;
                  setCreating(false);
                  change({ project: e.target.value, repo: "", number: undefined, page: 1 });
                }}
              >
                {projects.ids.map((id) => (
                  <option key={id} value={id}>
                    {projects.name(id)}
                  </option>
                ))}
              </select>
            </label>
            <form
              className="flex min-w-0 flex-1 gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                try {
                  const parsed = address.startsWith("https://")
                    ? issueFromUrl(address.trim())
                    : undefined;
                  const number = parsed?.number ?? Number(address.replace(/^#/, "").trim());
                  if (!Number.isSafeInteger(number) || number < 1) throw new Error();
                  setError("");
                  open(
                    number,
                    parsed
                      ? `${parsed.repository.host}/${parsed.repository.owner}/${parsed.repository.name}`
                      : location.repo,
                  );
                } catch {
                  setError("Enter a GitHub issue URL or a positive issue number.");
                }
              }}
            >
              <Input
                aria-label="Issue URL or number"
                placeholder="GitHub issue URL or #number"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
              />
              <Button type="submit" disabled={!workspaceId || !address.trim()}>
                Open issue
              </Button>
            </form>
          </div>
          {error && <p role="alert">{error}</p>}
          {projects.loaded && !projects.ids.length && (
            <p>Add a GitHub project to browse its issues.</p>
          )}
          {workspaceId &&
            (location.number ? (
              <>
                <Button onClick={() => change({ number: undefined })}>Back to issues</Button>
                <IssueDetail
                  key={`${workspaceId}/${location.repo}/${location.number}`}
                  workspaceId={workspaceId}
                  repository={repository}
                  number={location.number}
                />
              </>
            ) : (
              <>
                <div className="flex gap-2">
                  {(["open", "closed"] as const).map((state) => (
                    <Button
                      key={state}
                      variant={location.state === state ? "primary" : "outline"}
                      onClick={() => change({ state, page: 1 })}
                    >
                      {state === "open" ? "Open" : "Closed"} {query.data?.counts[state] ?? ""}
                    </Button>
                  ))}
                  <Button disabled={!query.data?.canCreate} onClick={() => setCreating(!creating)}>
                    New issue
                  </Button>
                  <Button onClick={() => void query.refetch()}>Refresh issues</Button>
                </div>
                {query.data && !query.data.canCreate && <p>{query.data.unavailableReason}</p>}
                <form
                  key={`${workspaceId}/${location.repo}`}
                  className="grid gap-3 sm:grid-cols-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const fields = new FormData(e.currentTarget);
                    change({
                      search: String(fields.get("search") ?? ""),
                      labels: String(fields.get("labels") ?? "")
                        .split(",")
                        .map((value) => value.trim())
                        .filter(Boolean),
                      author: String(fields.get("author") ?? ""),
                      assignee: String(fields.get("assignee") ?? ""),
                      milestone: String(fields.get("milestone") ?? ""),
                      page: 1,
                    });
                  }}
                >
                  <Input
                    name="search"
                    aria-label="Search issues"
                    defaultValue={location.search}
                    placeholder="Search issues"
                    maxLength={256}
                  />
                  <Input
                    name="labels"
                    aria-label="Issue labels"
                    defaultValue={location.labels.join(", ")}
                    placeholder="Labels, separated by commas"
                  />
                  <Input
                    name="author"
                    aria-label="Issue author"
                    defaultValue={location.author}
                    placeholder="Author"
                    pattern="[\w-]*"
                  />
                  <Input
                    name="assignee"
                    aria-label="Issue assignee"
                    defaultValue={location.assignee}
                    placeholder="Assignee"
                    pattern="[\w-]*"
                  />
                  <Input
                    name="milestone"
                    aria-label="Issue milestone"
                    defaultValue={location.milestone}
                    placeholder="Milestone"
                  />
                  <Button type="submit">Apply issue filters</Button>
                </form>
                <div className="flex gap-3">
                  <label className="text-sm">
                    Sort{" "}
                    <select
                      aria-label="Issue sort"
                      className="bg-input p-1 focus-ring"
                      value={location.sort}
                      onChange={(e) => {
                        const sort = e.target.value;
                        if (sort === "created" || sort === "updated" || sort === "comments")
                          change({ sort, page: 1 });
                      }}
                    >
                      <option value="created">Created</option>
                      <option value="updated">Updated</option>
                      <option value="comments">Comments</option>
                    </select>
                  </label>
                  <Button
                    onClick={() =>
                      change({ order: location.order === "asc" ? "desc" : "asc", page: 1 })
                    }
                  >
                    {location.order === "desc" ? "Newest first" : "Oldest first"}
                  </Button>
                </div>
                <QueryState query={query} />
                {creating && query.data && (
                  <IssueEditor
                    key={JSON.stringify([workspaceId, query.data.repository])}
                    workspaceId={workspaceId}
                    repository={query.data.repository}
                    action="create"
                    onSaved={(issue) => {
                      refreshIssueLists(cache, workspaceId, issue.repository);
                      setCreating(false);
                      open(
                        issue.number,
                        `${issue.repository.host}/${issue.repository.owner}/${issue.repository.name}`,
                      );
                    }}
                  />
                )}
                {query.data && (
                  <>
                    <p className="text-sm text-muted-foreground">
                      {query.data.total} issues · Page {location.page}
                    </p>
                    {(query.data.incomplete || query.data.truncated) && (
                      <p role="status">
                        GitHub returned a partial search. Search results are limited to 1,000
                        issues; narrow the filters.
                      </p>
                    )}
                    <ul className="divide-y divide-border">
                      {query.data.items.map((issue) => (
                        <li key={issue.ref.number} className="py-4">
                          <button
                            className="text-left text-base font-medium text-link hover:underline focus-ring"
                            onClick={() => open(issue.ref.number)}
                          >
                            {issue.title} #{issue.ref.number}
                          </button>
                          <p className="mt-1 text-sm text-muted-foreground">
                            {issue.state} · {issue.author} · {issue.labels.join(" · ")} ·{" "}
                            {issue.updatedAt}
                          </p>
                        </li>
                      ))}
                    </ul>
                    {!query.data.items.length && <p>No issues match these filters.</p>}
                    <div className="flex gap-2">
                      <Button
                        disabled={location.page === 1}
                        onClick={() => change({ page: location.page - 1 })}
                      >
                        Previous issues
                      </Button>
                      <Button
                        disabled={!query.data.nextPage}
                        onClick={() =>
                          query.data?.nextPage && change({ page: query.data.nextPage })
                        }
                      >
                        Next issues
                      </Button>
                    </div>
                  </>
                )}
              </>
            ))}
        </div>
      </div>
    </Screen>
  );
}
