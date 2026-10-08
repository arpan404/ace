import { CaretDownIcon, FolderSimpleIcon, DotsThreeIcon } from "@phosphor-icons/react";
import { projectTint } from "@ace/ui-core";
import { useMemo } from "react";
import { Icon } from "@/components/icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
} from "@/components/ui/context-menu.tsx";
import { cn } from "@/lib/cn.ts";
import {
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { useProjectDirectory } from "@/lib/projects.ts";
import { useProjects } from "./use-home-threads.ts";
import { useOrganizer, useOrganizerState } from "@/features/organize/index.ts";
import { AddProjectItem, ManageProjectItems } from "@/features/projects/index.ts";

/**
 * The Threads heading's project filter: out of the way until the pointer or
 * keyboard is on the heading, or a filter narrows the list.
 */
export function ThreadsActions() {
  const { project } = useOrganizerState();
  return (
    <span
      className={cn(
        "flex items-center gap-0.5 opacity-0 transition-opacity duration-(--dur-1) group-focus-within/heading:opacity-100 group-hover/heading:opacity-100",
        project !== null && "opacity-100",
      )}
    >
      <ProjectFilter />
    </span>
  );
}

const all = "\u0000all";

/**
 * "All projects ▾" narrows Home to one project and offers actions for each project. Every project the daemon
 * lists is here, with or without threads, beside any project only threads still mention.
 */
export function ProjectFilter() {
  const organizer = useOrganizer();
  const { project } = useOrganizerState();
  const withThreads = useProjects();
  const directory = useProjectDirectory();
  const { name } = directory;
  const label = project === null ? "All projects" : name(project);
  const total = withThreads.reduce((sum, p) => sum + p.threads, 0);
  const rows = useMemo(() => {
    const counts = new Map(withThreads.map((p) => [p.id, p.threads]));
    const ids = [...new Set([...directory.projects.map((p) => p.id), ...counts.keys()])];
    return ids
      .map((id) => ({ id, label: name(id), threads: counts.get(id) ?? 0 }))
      .toSorted((a, b) => a.label.localeCompare(b.label));
  }, [withThreads, directory.projects, name]);

  return (
    <Menu>
      <MenuTrigger
        aria-label={`Project filter: ${label}`}
        className="inline-flex h-[26px] max-w-[140px] items-center gap-1 rounded-sm pr-2 pl-[9px] text-sm font-medium text-muted-foreground outline-none transition-colors duration-(--dur-1) hover:bg-sidebar-accent hover:text-foreground aria-expanded:bg-sidebar-accent aria-expanded:text-foreground"
      >
        <span className="truncate">{label}</span>
        <CaretDownIcon aria-hidden size={14} className="shrink-0" />
      </MenuTrigger>
      <MenuContent align="end" className="max-h-[60vh] min-w-[220px] overflow-y-auto">
        <MenuRadioGroup
          value={project ?? all}
          onValueChange={(value) =>
            organizer.setProject(typeof value === "string" && value !== all ? value : null)
          }
        >
          <ProjectItem value={all} label="All projects" count={total} />
          {rows.length > 0 && <MenuSeparator />}
          {rows.map((row) => (
            <ProjectItem
              key={row.id}
              value={row.id}
              label={row.label}
              count={row.threads}
              registered={directory.projects.some((p) => p.id === row.id)}
            />
          ))}
        </MenuRadioGroup>
        {directory.projects.length > 0 && (
          <>
            <MenuSeparator />
            <AddProjectItem />
          </>
        )}
      </MenuContent>
    </Menu>
  );
}

/** A project in the filter, its folder in the project's tint as on its rows; All stays grey. */
function ProjectItem(props: { value: string; label: string; count: number; registered?: boolean }) {
  const item = (
    <MenuRadioItem value={props.value} aria-label={props.label} className="flex-1">
      <span className="flex items-center gap-[9px]">
        <span
          className="flex text-muted-foreground"
          style={
            props.value === all
              ? undefined
              : { color: `var(--project-${projectTint(props.value)})` }
          }
        >
          <Icon icon={FolderSimpleIcon} />
        </span>
        {props.label}
        <span className="ml-auto pl-4 text-xs text-subtle-foreground">{props.count}</span>
      </span>
    </MenuRadioItem>
  );
  if (!props.registered) return item;
  const actions = <ManageProjectItems projectId={props.value} name={props.label} />;
  return (
    <div className="flex items-center">
      <ContextMenu>
        <ContextMenuTrigger render={<div className="flex-1" />}>{item}</ContextMenuTrigger>
        <ContextMenuContent aria-label={`Actions for ${props.label}`}>{actions}</ContextMenuContent>
      </ContextMenu>
      <MenuSub>
        <Tip label={`Actions for ${props.label}`}>
          <MenuSubTrigger
            aria-label={`Actions for ${props.label}`}
            className="w-auto px-2 [&>svg:last-child]:hidden"
          >
            <DotsThreeIcon aria-hidden size={16} />
          </MenuSubTrigger>
        </Tip>
        <MenuContent aria-label={`Actions for ${props.label}`}>{actions}</MenuContent>
      </MenuSub>
    </div>
  );
}
