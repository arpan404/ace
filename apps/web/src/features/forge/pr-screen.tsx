import { useEffect, useMemo, useRef, useState } from "react";
import type { ForgePrSearch } from "@ace/protocol";
import { prFromUrl, prRepository } from "@ace/forge/pr-reference";
import { useRegisteredProjects } from "@/lib/projects.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { Screen } from "@/features/shell/index.ts";
import { Input } from "@/components/ui/input.tsx";
import { Button } from "@/components/ui/button.tsx";
import { PrWorkspaceExtensionProvider } from "./pr-extension-context.tsx";
import type { PrWorkspaceExtensions, PrListExtensions } from "./pr-extensions.ts";
import { PrList } from "./pr-list.tsx";
import { prWorkspace } from "./pr-workspace.ts";
import { prPanelId } from "./pr-panel-data.ts";
import { useWorkspaceActions, useWorkspaceStore } from "@/lib/workspace/index.ts";
import { QueryState } from "./query-state.tsx";
import { readForge } from "./source.ts";

export interface PrLocation extends ForgePrSearch {
  project: string;
  repo: string;
  number?: number | undefined;
  tab: "summary" | "timeline" | "code" | "conversation" | "commits" | "checks" | "files";
}
export function PrScreen(props: {
  location: PrLocation;
  onLocation(location: PrLocation): void;
  extensions?: PrWorkspaceExtensions;
  listExtensions?: PrListExtensions;
}) {
  const projects = useRegisteredProjects();
  const location = props.location;
  const workspaceId = location.project || projects.ids[0] || "";
  const scope = `forge:${workspaceId}`;
  const store = useWorkspaceStore();
  store.define(scope, prWorkspace);
  const actions = useWorkspaceActions(scope);
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const repository = useMemo(
    () =>
      location.repo
        ? prRepository(location.repo, {
            forge: "github",
            host: "github.com",
            owner: "unused",
            name: "unused",
          })
        : undefined,
    [location.repo],
  );
  const query = useDaemonQuery({
    queryKey: [
      "forge",
      workspaceId,
      repository,
      "prList",
      location.state,
      location.search,
      location.author,
      location.reviewer,
      location.sort,
      location.order,
      location.page,
    ],
    enabled: Boolean(workspaceId),
    retry: false,
    staleTime: 30_000,
    refetchOnReconnect: "always",
    read: async (client, signal) => {
      const result = await readForge(
        client,
        {
          op: "forge.pr.list",
          workspaceId,
          repository,
          query: {
            state: location.state,
            search: location.search,
            author: location.author,
            reviewer: location.reviewer,
            sort: location.sort,
            order: location.order,
            page: location.page,
          },
        },
        signal,
      );
      if (result.resource !== "prList") throw new Error("No pull request list.");
      return result.value;
    },
  });
  useEffect(() => {
    if (!workspaceId || !location.number) return;
    const id = prPanelId({ workspaceId, repository, number: location.number });
    actions.open({
      kind: "pull-request",
      id,
      title: `#${location.number}`,
      data: { workspaceId, repository, number: location.number },
    });
    actions.updateUi(`pull-request:${id}`, { selected: location.tab });
  }, [workspaceId, location.number, location.tab, actions, repository]);
  // A fresh launcher inherits the selected repository, but does not copy provider data.
  useEffect(
    () =>
      store.subscribe(scope, () => {
        const workspace = store.get(scope);
        const active = workspace.tabs.find((tab) => tab.key === workspace.active);
        if (active?.kind === "pr-new" && active.data === undefined)
          actions.update(active.key, { data: { workspaceId, repository, number: 1 } });
      }),
    [store, scope, actions, workspaceId, repository],
  );
  const open = () => {
    setError("");
    try {
      const parsed = address.startsWith("https://") ? prFromUrl(address.trim()) : undefined;
      const number = parsed?.number ?? Number(address.replace(/^#/, "").trim());
      if (!Number.isSafeInteger(number) || number < 1)
        throw new Error("Enter a GitHub PR URL or a positive PR number.");
      props.onLocation({
        ...location,
        project: workspaceId,
        repo: parsed
          ? `${parsed.repository.host}/${parsed.repository.owner}/${parsed.repository.name}`
          : location.repo,
        number,
        tab: "summary",
      });
    } catch {
      setError("Enter a GitHub PR URL or a positive PR number.");
    }
  };
  return (
    <PrWorkspaceExtensionProvider value={props.extensions}>
      <Screen title="Pull requests" workspace={{ scope, definition: prWorkspace }}>
        <div ref={scroller} className="h-full overflow-auto">
          <div className="mx-auto max-w-[1040px] space-y-4 px-4 py-4 sm:px-6">
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-sm">
                Project{" "}
                <select
                  aria-label="Repository project"
                  value={workspaceId}
                  className="bg-input p-1 focus-ring"
                  onChange={(e) => {
                    if (scroller.current) scroller.current.scrollTop = 0;
                    props.onLocation({
                      ...location,
                      project: e.target.value,
                      repo: "",
                      number: undefined,
                      page: 1,
                    });
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
                  open();
                }}
              >
                <Input
                  aria-label="PR URL or number"
                  value={address}
                  onChange={(e) => setAddress(e.target.value)}
                  placeholder="GitHub PR URL or #number"
                />
                <Button type="submit" disabled={!workspaceId || !address.trim()}>
                  Open PR
                </Button>
              </form>
            </div>
            {error && <p role="alert">{error}</p>}
            {projects.loaded && !projects.ids.length && (
              <p>Add a GitHub project to browse its pull requests.</p>
            )}
            {workspaceId && (
              <>
                <QueryState query={query} />
                <PrList
                  key={`${workspaceId}/${location.repo}/${location.search}/${location.author}/${location.reviewer}`}
                  value={query.data}
                  extensions={props.listExtensions}
                  query={location}
                  selected={location.number}
                  onQuery={(next) => {
                    if (scroller.current) scroller.current.scrollTop = 0;
                    props.onLocation({ ...location, ...next, project: workspaceId });
                  }}
                  onOpen={(number) => {
                    props.onLocation({ ...location, project: workspaceId, number, tab: "summary" });
                  }}
                />
              </>
            )}
          </div>
        </div>
      </Screen>
    </PrWorkspaceExtensionProvider>
  );
}
