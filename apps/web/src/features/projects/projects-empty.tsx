import { FolderPlusIcon, FolderSimpleIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { useProjectDialogs } from "./projects-host.tsx";

/** The first run's next step: choose a folder, create one or clone inside Add project. */
export function ProjectsEmptyState(props: { heading?: boolean; className?: string }) {
  const projects = useProjectDialogs();
  return (
    <EmptyState
      icon={FolderSimpleIcon}
      {...(props.heading ? { heading: true } : {})}
      {...(props.className ? { className: props.className } : {})}
      title="Add your first project"
      description="A project is a folder on one of your machines. Agents work there with your own tools."
      action={
        <Button
          onClick={() => projects.open({ kind: "add", tab: "open" })}
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
