import { FolderPlusIcon, FolderSimpleIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { useProjectDialogs } from "./projects-host.tsx";

/** The first run's next step: Add project, in the palette. */
export function ProjectsEmptyState(props: { heading?: boolean; className?: string }) {
  const projects = useProjectDialogs();
  return (
    <EmptyState
      icon={FolderSimpleIcon}
      {...(props.heading ? { heading: true } : {})}
      {...(props.className ? { className: props.className } : {})}
      title="Add your first project"
      description="A folder on this machine that agents work in."
      action={
        <Button
          onClick={() => projects.open({ kind: "add", tab: "sources" })}
          onPointerEnter={projects.preload}
          onFocus={projects.preload}
        >
          <Icon icon={FolderPlusIcon} size={14} />
          Add a project
        </Button>
      }
    />
  );
}
