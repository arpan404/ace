import { createFileRoute } from "@tanstack/react-router";
import { CubeIcon } from "@phosphor-icons/react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Screen } from "@/features/shell/screen.tsx";

export const Route = createFileRoute("/skills/")({
  component: () => (
    <Screen title="Skills">
      <EmptyState
        icon={CubeIcon}
        title="No skill selected"
        description="Skills teach your agents a workflow. Pick one to see what it does and where it applies."
      />
    </Screen>
  ),
});
