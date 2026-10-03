import { ClockIcon } from "@phosphor-icons/react";
import { Link, Navigate } from "@tanstack/react-router";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Screen } from "@/features/shell/index.ts";
import { daemonErrorCode, describeDaemonError } from "@/lib/daemon-command.ts";
import { useAutomations } from "./use-automations.ts";

/** Automations opens on the first one in the list; with none yet, says how to make one. */
export function AutomationsEmptyScreen() {
  const list = useAutomations();
  const first = list.data?.[0];
  if (first)
    return (
      <Navigate
        to="/automations/$automationId"
        params={{ automationId: first.automation.id }}
        replace
      />
    );
  if (list.isError && !list.data)
    return (
      <Screen title="Automations">
        <EmptyState
          icon={ClockIcon}
          title="Automations unavailable"
          description={describeDaemonError(daemonErrorCode(list.error))}
          action={
            <Button size="sm" onClick={() => void list.refetch()}>
              Try again
            </Button>
          }
        />
      </Screen>
    );
  // Until the list arrives there's nothing to say: the sidebar shows its skeleton.
  if (!list.data) return <Screen title="Automations">{null}</Screen>;
  return (
    <Screen title="Automations">
      <EmptyState
        icon={ClockIcon}
        title="No automation selected"
        description="Automations run a prompt on a schedule or a repository event and report back in Activity."
        action={
          <Link to="/automations/new" className={buttonVariants({ size: "sm" })}>
            New automation
          </Link>
        }
      />
    </Screen>
  );
}
