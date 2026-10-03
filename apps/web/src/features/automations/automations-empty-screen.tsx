import { ClockIcon } from "@phosphor-icons/react";
import { Link } from "@tanstack/react-router";
import { buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Screen } from "@/features/shell/index.ts";

/** Automations with none selected. */
export function AutomationsEmptyScreen() {
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
