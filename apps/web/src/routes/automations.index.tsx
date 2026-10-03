import { createFileRoute, Link } from "@tanstack/react-router";
import { ClockIcon } from "@phosphor-icons/react";
import { buttonVariants } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Screen } from "@/features/shell/screen.tsx";

export const Route = createFileRoute("/automations/")({
  component: () => (
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
  ),
});
