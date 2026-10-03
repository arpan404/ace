import { ClockIcon } from "@phosphor-icons/react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ViewSidebar } from "@/features/shell/view-frame.tsx";

/** Automations' second sidebar. TODO(automations slice): scheduled and triggered runs. */
export function AutomationsSidebar() {
  return (
    <ViewSidebar title="Automations">
      <EmptyState
        icon={ClockIcon}
        title="No automations"
        description="Run a prompt on a schedule or when something happens in a repository."
      />
    </ViewSidebar>
  );
}
