import { prUrl } from "@ace/forge/pr-reference";
import { GitPullRequestIcon } from "@phosphor-icons/react";
import type { ForgePrRef, ForgeRepository } from "@ace/protocol";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { useOpenWebAddress } from "@/components/web-link.tsx";
import { failureCode } from "@/lib/forge-read.ts";
import { forgeDisplayName, forgeErrorText, reviewNoun } from "@ace/ui-core";

const capitalized = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);

/** The review's page on its host, for the providers whose addresses ace knows. */
function webAddress(pr: ForgePrRef): string | undefined {
  try {
    return prUrl(pr);
  } catch {
    return undefined;
  }
}

/**
 * A review that couldn't be read at all: what happened in the daemon's words, Retry, and the
 * review on its host when ace knows its address.
 */
export function PrFailure(props: {
  repository?: ForgeRepository | undefined;
  number: number;
  error: Error;
  onRetry(): void;
}) {
  const openWeb = useOpenWebAddress();
  const repository = props.repository;
  const web = repository && webAddress({ repository, number: props.number });
  const noun = reviewNoun(repository?.forge);
  const missing = failureCode(props.error) === "forge_not_found";
  return (
    <EmptyState
      icon={GitPullRequestIcon}
      title={
        missing
          ? `${capitalized(noun)} #${props.number} not found`
          : `Couldn't load ${noun} #${props.number}`
      }
      description={
        failureCode(props.error)
          ? forgeErrorText(failureCode(props.error), repository?.forge)
          : props.error.message
      }
      action={
        <div className="flex gap-2">
          <Button size="sm" onClick={props.onRetry}>
            Retry
          </Button>
          {repository && web && (
            <Button
              size="sm"
              variant="ghost"
              onClick={(event) => void openWeb(web, event).catch(() => {})}
            >
              Open on {forgeDisplayName(repository.forge)}
            </Button>
          )}
        </div>
      }
    />
  );
}
