import { createFileRoute } from "@tanstack/react-router";
import { FilesIcon } from "@phosphor-icons/react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Screen } from "@/features/shell/screen.tsx";

/** TODO(files slice): changed files across threads, file transfer. */
export const Route = createFileRoute("/more/files")({
  component: () => (
    <Screen title="Files">
      <EmptyState
        icon={FilesIcon}
        title="No changed files"
        description="Files the agents change, in every thread, collect here."
      />
    </Screen>
  ),
});
