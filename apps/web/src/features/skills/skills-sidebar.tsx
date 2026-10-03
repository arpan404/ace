import { CubeIcon } from "@phosphor-icons/react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ViewSidebar } from "@/features/shell/view-frame.tsx";

/** Skills' second sidebar. TODO(skills slice): skills, slash commands and plugins. */
export function SkillsSidebar() {
  return (
    <ViewSidebar title="Skills">
      <EmptyState
        icon={CubeIcon}
        title="No skills found"
        description="Skills and commands your agents can use appear here."
      />
    </ViewSidebar>
  );
}
