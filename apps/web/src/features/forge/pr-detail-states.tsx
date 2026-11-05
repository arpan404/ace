import { prUrl } from "@ace/forge/pr-reference";
import { GitPullRequestIcon } from "@phosphor-icons/react";
import type { ForgeRepository } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { useOpenWebAddress } from "@/components/web-link.tsx";
import { failureCode } from "@/lib/forge-read.ts";

/** A PR that couldn't be read at all: what happened, Retry, and the PR on GitHub. */
export function PrFailure(props: {
  repository?: ForgeRepository | undefined;
  number: number;
  error: Error;
  onRetry(): void;
}) {
  const openWeb = useOpenWebAddress();
  const repository = props.repository;
  const supported = repository && ["github", "gitlab", "origin"].includes(repository.forge);
  const url = supported ? prUrl({ repository, number: props.number }) : undefined;
  const host =
    repository?.forge === "origin"
      ? "Cursor Origin"
      : repository?.forge === "gitlab"
        ? "GitLab"
        : "GitHub";
  const missing = failureCode(props.error) === "forge_not_found";
  return (
    <EmptyState
      icon={GitPullRequestIcon}
      title={
        missing
          ? `Pull request #${props.number} not found`
          : `Couldn't load pull request #${props.number}`
      }
      description={props.error.message.replaceAll("GitHub", host)}
      action={
        <div className="flex gap-2">
          <Button size="sm" onClick={props.onRetry}>
            Retry
          </Button>
          {url && (
            <Button
              size="sm"
              variant="ghost"
              onClick={(event) => void openWeb(url, event).catch(() => {})}
            >
              Open on {host}
            </Button>
          )}
        </div>
      }
    />
  );
}
