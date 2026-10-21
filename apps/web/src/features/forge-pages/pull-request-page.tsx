import { useNavigate } from "@tanstack/react-router";
import type { ForgePrRef, ForgeRepository } from "@ace/protocol";
import { PullRequestOpener } from "@/components/pull-request-link.tsx";
import { PrDetail } from "@/features/forge/index.ts";
import { Screen } from "@/features/shell/index.ts";
import { useSidebarInline } from "@/lib/breakpoints.ts";
import { useForgeBrowse } from "./browse-context.tsx";

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

/**
 * One pull request as a page of its own: the PR panel's whole view (summary, timeline, code,
 * merge and review) at the width of the main column. A link to another PR opens it here too.
 */
export function PullRequestPage(props: {
  project: string;
  number: number;
  repository?: ForgeRepository | undefined;
  tab: string;
  onTab(tab: string): void;
}) {
  const browse = useForgeBrowse();
  const navigate = useNavigate();
  const wide = useSidebarInline();
  const open = (pr: ForgePrRef) =>
    void navigate({
      to: "/pulls/$project/$number",
      params: { project: props.project, number: String(pr.number) },
      search: { repo: repositoryParam(pr.repository) },
    });
  return (
    <Screen title="Pull requests" crumb={browse.projectName(props.project)}>
      <PullRequestOpener value={open}>
        <PrDetail
          key={`${props.project}:${props.repository ? repositoryParam(props.repository) : ""}#${props.number}`}
          workspaceId={props.project}
          repository={props.repository}
          number={props.number}
          tab={props.tab}
          onTab={props.onTab}
          onOpen={(number) =>
            void navigate({
              to: "/pulls/$project/$number",
              params: { project: props.project, number: String(number) },
              search: (current) => ({ repo: current.repo }),
            })
          }
          {...(wide ? {} : { onBack: () => void navigate({ to: "/pulls" }) })}
        />
      </PullRequestOpener>
    </Screen>
  );
}
