import {
  DownloadSimpleIcon,
  FolderOpenIcon,
  FolderPlusIcon,
  FolderSimpleIcon,
} from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty.tsx";
import { useProjectDialogs } from "./projects-host.tsx";
import type { AddTab } from "./requests.ts";

const actions: { tab: AddTab; label: string; icon: typeof FolderOpenIcon }[] = [
  { tab: "open", label: "Open a folder", icon: FolderOpenIcon },
  { tab: "create", label: "Create a project", icon: FolderPlusIcon },
  { tab: "clone", label: "Clone a repository", icon: DownloadSimpleIcon },
];

/**
 * No projects yet (the first run, or every project removed): the three ways to add one.
 * `heading` makes the title the view's h1.
 */
export function ProjectsEmptyState(props: { heading?: boolean; className?: string }) {
  const projects = useProjectDialogs();
  return (
    <EmptyState
      icon={FolderSimpleIcon}
      {...(props.heading ? { heading: true } : {})}
      {...(props.className ? { className: props.className } : {})}
      title="Add your first project"
      description="A project is a folder on this machine. Open one you have, start a new one, or clone a repository; agents work there with your own tools."
      action={
        <div className="flex flex-wrap justify-center gap-2">
          {actions.map((action) => (
            <Button
              key={action.tab}
              onClick={() => projects.open({ kind: "add", tab: action.tab })}
              onPointerEnter={projects.preload}
              onFocus={projects.preload}
            >
              <Icon icon={action.icon} size={14} />
              {action.label}
            </Button>
          ))}
        </div>
      }
    />
  );
}
