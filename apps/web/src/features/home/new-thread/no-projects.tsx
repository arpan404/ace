import { FolderSimpleIcon } from "@phosphor-icons/react";
import { EmptyState } from "@/components/ui/empty.tsx";
import { ProjectsEmptyState, useProjectDialogs } from "@/features/projects/index.ts";
import { Screen } from "@/features/shell/index.ts";
import { useNewThreadMachines } from "./machine-choice.ts";

/**
 * New thread with no project to start in. On another machine it says which, and offers going
 * back to this window's own: the strip with the machine picker only shows with a project.
 */
export function NoProjects() {
  const choice = useNewThreadMachines();
  const dialogs = useProjectDialogs();
  const own = choice?.machines.find((machine) => machine.primary);
  if (!choice || choice.current.primary || !own)
    return (
      <Screen title="New thread">
        <ProjectsEmptyState />
      </Screen>
    );
  const link =
    "text-ui font-medium text-foreground underline-offset-4 hover:underline focus-ring rounded-sm";
  return (
    <Screen title="New thread">
      <EmptyState
        icon={FolderSimpleIcon}
        title={`No projects on ${choice.current.name}`}
        description="Add a folder there for agents to work in, or start on another machine."
        action={
          <span className="flex items-center gap-4">
            <button
              type="button"
              className={link}
              onClick={() => dialogs.open({ kind: "add", tab: "sources" })}
            >
              Add a project
            </button>
            <button type="button" className={link} onClick={() => choice.choose(own)}>
              Start on {own.name}
            </button>
          </span>
        }
      />
    </Screen>
  );
}
