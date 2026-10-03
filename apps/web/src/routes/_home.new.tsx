import { createFileRoute } from "@tanstack/react-router";
import { NotePencilIcon } from "@phosphor-icons/react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Screen } from "@/features/shell/screen.tsx";

/** ⌘N. TODO(thread slice): project picker and composer that creates the thread on send. */
export const Route = createFileRoute("/_home/new")({
  component: () => (
    <Screen title="New thread">
      <EmptyState
        icon={NotePencilIcon}
        title="Start a thread"
        description="Pick a project and describe the work. The thread is created when you send."
      />
    </Screen>
  ),
});
