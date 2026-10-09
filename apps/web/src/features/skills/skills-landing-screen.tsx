import { CubeIcon } from "@phosphor-icons/react";
import { Navigate } from "@tanstack/react-router";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { LoadingRegion, SkeletonText } from "@/components/ui/skeleton.tsx";
import { Screen, ViewListPage } from "@/features/shell/index.ts";
import { useInstallDialog } from "./install-plugin.tsx";
import { skillsLoadError } from "./skills-model.ts";
import { catalogOrder } from "./skills-sidebar.tsx";
import { useSkills } from "./skills-source.ts";

/**
 * Skills opens its first row when discovery supplies the catalog.
 */
export function SkillsLandingScreen() {
  const skills = useSkills();
  const dialog = useInstallDialog();
  const first = catalogOrder(skills.data ?? [])[0];
  // A narrow window shows the catalog as the page; a wide one opens its first entry.
  if (first)
    return (
      <ViewListPage
        title="Skills"
        fallback={<Navigate to="/skills/$skillId" params={{ skillId: first.id }} replace />}
      />
    );
  return (
    <Screen title="Skills">
      {skills.isError ? (
        <EmptyState
          icon={CubeIcon}
          heading
          title="Skills unavailable"
          description={skillsLoadError}
          action={
            <Button size="sm" onClick={() => void skills.refetch()}>
              Try again
            </Button>
          }
        />
      ) : skills.data ? (
        <EmptyState
          icon={CubeIcon}
          heading
          title="No skills yet"
          description="Skills teach your agents a workflow. Install a plugin to add skills, slash commands, agents and rules."
          action={
            <Button variant="primary" onClick={dialog.install}>
              Install a plugin
            </Button>
          }
        />
      ) : (
        <SkillPageSkeleton />
      )}
    </Screen>
  );
}

/** The detail page's shape while the catalog loads: a title and its description. */
export function SkillPageSkeleton() {
  return (
    <LoadingRegion label="skills" className="mx-auto block max-w-(--column) px-8 pt-11">
      <SkeletonText lines={3} />
    </LoadingRegion>
  );
}
