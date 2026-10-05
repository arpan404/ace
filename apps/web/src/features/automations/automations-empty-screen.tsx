import { ClockIcon } from "@phosphor-icons/react";
import { Link, Navigate } from "@tanstack/react-router";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Screen, ViewListPage } from "@/features/shell/index.ts";
import { daemonErrorCode, describeDaemonError } from "@/lib/daemon-command.ts";
import { useAutomations } from "./use-automations.ts";

/**
 * Automations opens on the first one in the list; with none yet, the main pane alone says how
 * to make one (the sidebar keeps one quiet line).
 */
export function AutomationsEmptyScreen() {
  const list = useAutomations();
  const first = list.data?.[0];
  // A narrow window shows the list as the page; a wide one opens the first automation.
  if (first)
    return (
      <ViewListPage
        title="Automations"
        fallback={
          <Navigate
            to="/automations/$automationId"
            params={{ automationId: first.automation.id }}
            replace
          />
        }
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
        heading
        title="No automations yet"
        description="Run a prompt on a schedule, on a GitHub event, or by hand. Results land in Activity."
        action={
          <Link
            to="/automations/new"
            className={buttonVariants({ variant: "primary", size: "sm" })}
          >
            New automation
          </Link>
        }
      />
    </Screen>
  );
}
