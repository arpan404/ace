import { CubeIcon } from "@phosphor-icons/react";
import { Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { Screen } from "@/features/shell/index.ts";
import type { Skill } from "./skills-model.ts";
import { useSkills } from "./skills-source.ts";

/**
 * Skills opens on the first entry of the catalog as it first loads. A catalog that was empty
 * stays on this screen when a plugin arrives: installing one opens it instead.
 */
export function SkillsLandingScreen() {
  const skills = useSkills();
  const [firstLoad, setFirstLoad] = useState<readonly Skill[]>();
  if (firstLoad === undefined && skills.data !== undefined) setFirstLoad(skills.data);
  const first = firstLoad?.length ? skills.data?.[0] : undefined;
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
              : "Skills teach your agents a workflow. Install a plugin to add some."
          }
        />
      )}
    </Screen>
  );
}
