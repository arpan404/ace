import { CubeIcon } from "@phosphor-icons/react";
import { Navigate } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { LoadingRegion, SkeletonText } from "@/components/ui/skeleton.tsx";
import { daemonErrorCode, describeDaemonError } from "@/lib/daemon-command.ts";
import { Screen } from "@/features/shell/index.ts";
import { useInstallDialog } from "./install-plugin.tsx";
import type { Skill } from "./skills-model.ts";
import { catalogOrder } from "./skills-sidebar.tsx";
import { useSkills } from "./skills-source.ts";

/**
 * Skills opens on the sidebar's first row as the catalog first loads. A catalog that was empty
 * stays on this screen when a plugin arrives: installing one opens it instead.
 */
export function SkillsLandingScreen() {
  const skills = useSkills();
  const dialog = useInstallDialog();
  const [firstLoad, setFirstLoad] = useState<readonly Skill[]>();
  if (firstLoad === undefined && skills.data !== undefined) setFirstLoad(skills.data);
  const first = firstLoad?.length ? catalogOrder(skills.data ?? [])[0] : undefined;
  if (first) return <Navigate to="/skills/$skillId" params={{ skillId: first.id }} replace />;
  return (
    <Screen title="Skills">
      {skills.isError ? (
        <EmptyState
          icon={CubeIcon}
          heading
          title="Skills unavailable"
          description={describeDaemonError(daemonErrorCode(skills.error))}
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
