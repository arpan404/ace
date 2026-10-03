import { createFileRoute } from "@tanstack/react-router";
import { ClockIcon } from "@phosphor-icons/react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Screen } from "@/features/shell/screen.tsx";

export const Route = createFileRoute("/automations/")({
  component: () => (
    <Screen title="Automations">
      <EmptyState
        icon={ClockIcon}
        title="No automation selected"
        description="Automations run a prompt on a schedule or a repository event and report back in Activity."
      />
    </Screen>
  ),
});
