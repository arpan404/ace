import { useCallback, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ForgePrRef, ForgeRepository } from "@ace/protocol";
import { PullRequestOpener } from "@/components/pull-request-link.tsx";
import { PrDetail } from "@/features/forge/index.ts";
import type { PullsSearch } from "./pulls-model.ts";

/** `github.com/acme/ace`: a repository in an address, for a PR outside the project's own. */
export function repositoryParam(repository: ForgeRepository): string {
  return `${repository.host}/${repository.owner}/${repository.name}`;
}

export function repositoryFromParam(value: string | undefined): ForgeRepository | undefined {
  const parts = value?.split("/");
  if (!parts || parts.length !== 3 || parts.some((part) => !part)) return undefined;
  const [host = "", owner = "", name = ""] = parts;
  return { forge: "github", host, owner, name };
}

const tabs = ["summary", "timeline", "code"] as const;
const asTab = (tab: string) => tabs.find((known) => known === tab) ?? "summary";

/**
 * The open pull request beside the list: the PR panel's whole view (summary, timeline, code,
 * merge and review). A link to another PR opens it here in its place.
 */
export function PrPanel(props: {
  project: string;
  number: number;
  repo: string | undefined;
  tab: string;
  onSearch(patch: Partial<PullsSearch>): void;
}) {
  const repository = repositoryFromParam(props.repo);
  const cache = useQueryClient();
  const seen = useRef<string | undefined>(undefined);
  const project = props.project;
  // A PR that merged, closed or reopened here moves between the list's states: read it again.
  const onState = useCallback(
    (state: string) => {
      if (seen.current !== undefined && seen.current !== state)
        void cache.invalidateQueries({ queryKey: ["forge", project, "browse"] });
      seen.current = state;
    },
    [cache, project],
  );
  const open = (pr: ForgePrRef) =>
    props.onSearch({ pr: pr.number, repo: repositoryParam(pr.repository), tab: undefined });
  return (
    <PullRequestOpener value={open}>
      <PrDetail
        key={`${props.project}:${props.repo ?? ""}#${props.number}`}
        workspaceId={props.project}
        repository={repository}
        number={props.number}
        tab={props.tab}
        onState={onState}
        onTab={(tab) => {
          const next = asTab(tab);
          props.onSearch({ tab: next === "summary" ? undefined : next });
        }}
        onOpen={(number) => props.onSearch({ pr: number, tab: undefined })}
      />
    </PullRequestOpener>
  );
}
