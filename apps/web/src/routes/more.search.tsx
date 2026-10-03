import { createFileRoute } from "@tanstack/react-router";
import { MagnifyingGlassIcon } from "@phosphor-icons/react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Screen } from "@/features/shell/screen.tsx";

/** TODO(search slice): full-text search across threads. */
export const Route = createFileRoute("/more/search")({
  component: () => (
    <Screen title="Search">
      <EmptyState
        icon={MagnifyingGlassIcon}
        title="Search every thread"
        description="Find a message, command or file across all projects and machines."
      />
    </Screen>
  ),
});
