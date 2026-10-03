import { createFileRoute, Navigate } from "@tanstack/react-router";
import { CubeIcon } from "@phosphor-icons/react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { useSkills } from "@/features/skills/skills-source.ts";
import { Screen } from "@/features/shell/screen.tsx";

/** Skills opens on the first entry of the catalog. */
export const Route = createFileRoute("/skills/")({ component: SkillsIndex });

function SkillsIndex() {
  const skills = useSkills();
  const first = skills.data?.[0];
  if (first) return <Navigate to="/skills/$skillId" params={{ skillId: first.id }} replace />;
  return (
    <Screen title="Skills">
      {(skills.data || skills.isError) && (
        <EmptyState
          icon={CubeIcon}
          heading
          title={skills.isError ? "Skills unavailable" : "No skills yet"}
          description={
            skills.isError
              ? skills.error.message
              : "Skills teach your agents a workflow. Add one to .claude/skills or install a plugin."
          }
        />
      )}
    </Screen>
  );
}
