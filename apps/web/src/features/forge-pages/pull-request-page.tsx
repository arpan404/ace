import { lazy, Suspense, useCallback, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { ForgePrRef, ForgeRepository } from "@ace/protocol";
import { IssuePages } from "@/components/forge-links.tsx";
import { PullRequestOpener } from "@/components/pull-request-link.tsx";
import { loadPrDetail, PrPageSkeleton } from "@/features/forge/index.ts";
import { Screen } from "@/features/shell/index.ts";
import { useBackToList } from "./back-to-list.ts";
import { cachedRow } from "./lists.ts";
import { useProjectChoice } from "./project-choice.ts";
import { repositoryFromParam, repositoryParam } from "@/lib/pull-request-route.ts";

/** The PR view arrives with its page, never with the app's first paint. */
const PrDetail = lazy(() => loadPrDetail().then((module) => ({ default: module.PrDetail })));

const tabs = ["summary", "timeline", "code"] as const;
export type PullRequestTab = (typeof tabs)[number];

/**
 * One pull request as a page in the main column: the PR view's whole content (summary, timeline,
 * code, merge and review) at a readable width, the Code tab at full width. Back (or Escape)
 * returns to the list as it was; a link to another PR opens it here.
 */
export function PullRequestPage(props: {
  project: string;
  number: number;
  repo: string | undefined;
  tab: PullRequestTab | undefined;
  /** The list's own address, when opened from it. */
  back: string | undefined;
  onTab(tab: PullRequestTab | undefined): void;
}) {
  const { project } = props;
  const choice = useProjectChoice(project);
  const navigate = useNavigate();
  const back = useBackToList("/pulls", project, props.back);
  const cache = useQueryClient();
  // The list's row for this PR, if one was read: the page shows it at once while the rest loads.
  const seed = cachedRow(cache, project, "prList", props.number, repositoryFromParam(props.repo));
  const seen = useRef<string | undefined>(undefined);
  // A PR that merged, closed or reopened here moves between the list's states: read it again.
  const onState = useCallback(
    (state: string) => {
      if (seen.current !== undefined && seen.current !== state)
        void cache.invalidateQueries({ queryKey: ["forge", project, "browse"] });
      seen.current = state;
    },
    [cache, project],
  );
  const open = (number: number, repository?: ForgeRepository) =>
    void navigate({
      to: "/pulls/$project/$number",
      params: { project, number: String(number) },
      search: {
        ...(repository
          ? { repo: repositoryParam(repository) }
          : props.repo
            ? { repo: props.repo }
            : {}),
        ...(props.back !== undefined ? { back: props.back } : {}),
      },
    });
  return (
    <Screen title={`#${props.number}`} crumb={choice.name(project)}>
      <PullRequestOpener value={(pr: ForgePrRef) => open(pr.number, pr.repository)}>
        <IssuePages project={project}>
          <Suspense
            fallback={
              <div className="h-full bg-panel [--forge-gutter:1rem] sm:[--forge-gutter:2rem]">
                <PrPageSkeleton
                  number={props.number}
                  seed={seed}
                  onBack={back}
                  readable="mx-auto w-full max-w-[64rem]"
                />
              </div>
            }
          >
            <PrDetail
              key={`${project}:${props.repo ?? ""}#${props.number}`}
              workspaceId={project}
              repository={repositoryFromParam(props.repo)}
              number={props.number}
              seed={seed}
              tab={props.tab ?? "summary"}
              onTab={(tab) => {
                const next = tabs.find((known) => known === tab) ?? "summary";
                props.onTab(next === "summary" ? undefined : next);
              }}
              onState={onState}
              onOpen={(number) => open(number)}
              onBack={back}
              page
            />
          </Suspense>
        </IssuePages>
      </PullRequestOpener>
    </Screen>
  );
}
