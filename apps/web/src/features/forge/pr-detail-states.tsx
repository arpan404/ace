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
  const url =
    repository &&
    `https://${repository.host}/${repository.owner}/${repository.name}/pull/${props.number}`;
  const missing = failureCode(props.error) === "forge_not_found";
  return (
    <EmptyState
      icon={GitPullRequestIcon}
      title={
        missing
          ? `Pull request #${props.number} not found`
          : `Couldn't load pull request #${props.number}`
      }
      description={props.error.message}
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
              Open on GitHub
            </Button>
          )}
        </div>
      }
    />
  );
}
