import { useLayoutEffect, useRef, useState } from "react";
import type { ForgePrSearch } from "@ace/protocol";
import { prFromUrl, prRepository } from "@ace/forge/pr-reference";
import { useRegisteredProjects } from "@/lib/projects.ts";
import { useDaemonQuery } from "@/lib/daemon-query.ts";
import { Screen } from "@/features/shell/index.ts";
import { Input } from "@/components/ui/input.tsx";
import { Button } from "@/components/ui/button.tsx";
import { PrStackGroups } from "./pr-stack-groups.tsx";
import { PrList } from "./pr-list.tsx";
import { PrDetail } from "./pr-detail.tsx";
import { QueryState } from "./query-state.tsx";
import { readForge } from "./source.ts";

export interface PrLocation extends ForgePrSearch {
  project: string;
  repo: string;
  number?: number | undefined;
  tab: "conversation" | "commits" | "checks" | "files";
}
export function PrScreen(props: { location: PrLocation; onLocation(location: PrLocation): void }) {
  const projects = useRegisteredProjects();
  const location = props.location;
  const workspaceId = location.project || projects.ids[0] || "";
  const [address, setAddress] = useState("");
  const [error, setError] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
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
      "prList",
      location.state,
      location.search,
      location.author,
      location.reviewer,
      location.sort,
      location.order,
      location.page,
    ],
    enabled: Boolean(workspaceId) && !location.number,
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
  useLayoutEffect(() => {
    if (scroller.current) scroller.current.scrollTop = location.number ? 0 : listScroll.current;
  }, [location.number]);
  const open = () => {
    setError("");
    try {
      const parsed = address.startsWith("https://") ? prFromUrl(address.trim()) : undefined;
      const number = parsed?.number ?? Number(address.replace(/^#/, "").trim());
      if (!Number.isSafeInteger(number) || number < 1)
        throw new Error("Enter a GitHub PR URL or a positive PR number.");
      if (scroller.current) listScroll.current = scroller.current.scrollTop;
      props.onLocation({
        ...location,
        project: workspaceId,
        repo: parsed
          ? `${parsed.repository.host}/${parsed.repository.owner}/${parsed.repository.name}`
          : location.repo,
        number,
        tab: "conversation",
      });
    } catch {
      setError("Enter a GitHub PR URL or a positive PR number.");
    }
  };
  return (
    <Screen title="Pull requests">
      <div ref={scroller} className="h-full overflow-auto">
        <div className="mx-auto max-w-[1040px] space-y-6 px-4 py-6 sm:px-8">
          <div className="flex flex-wrap items-center gap-3">
            <label className="text-sm">
              Project{" "}
              <select
                aria-label="Repository project"
                value={workspaceId}
                className="bg-input p-1 focus-ring"
                onChange={(e) => {
                  listScroll.current = 0;
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
          {workspaceId &&
            (location.number ? (
              <>
                <Button onClick={() => props.onLocation({ ...location, number: undefined })}>
                  Back to pull requests
                </Button>
                <PrDetail
                  key={`${workspaceId}/${location.repo}/${location.number}`}
                  workspaceId={workspaceId}
                  repository={repository}
                  number={location.number}
                  tab={location.tab}
                  onOpen={(number) =>
                    props.onLocation({ ...location, number, tab: "conversation" })
                  }
                  onTab={(tab) => {
                    if (
                      tab === "conversation" ||
                      tab === "commits" ||
                      tab === "checks" ||
                      tab === "files"
                    )
                      props.onLocation({ ...location, tab });
                  }}
                />
              </>
            ) : (
              <>
                <QueryState query={query} />
                {query.data && (
                  <PrStackGroups
                    workspaceId={workspaceId}
                    refs={query.data.items.map((pr) => pr.ref)}
                    onOpen={(ref) =>
                      props.onLocation({
                        ...location,
                        project: workspaceId,
                        number: ref.number,
                        tab: "conversation",
                      })
                    }
                  />
                )}
                <PrList
                  key={`${workspaceId}/${location.repo}/${location.search}/${location.author}/${location.reviewer}`}
                  value={query.data}
                  query={location}
                  onQuery={(next) => {
                    listScroll.current = 0;
                    props.onLocation({ ...location, ...next, project: workspaceId });
                  }}
                  onOpen={(number) => {
                    if (scroller.current) listScroll.current = scroller.current.scrollTop;
                    props.onLocation({
                      ...location,
                      project: workspaceId,
                      number,
                      tab: "conversation",
                    });
                  }}
                />
              </>
            ))}
        </div>
      </div>
    </Screen>
  );
}
