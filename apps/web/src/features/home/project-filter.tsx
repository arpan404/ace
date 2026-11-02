import { ProjectMark } from "@/components/project-mark.tsx";
import { CaretDownIcon, FolderSimpleIcon, DotsThreeIcon } from "@phosphor-icons/react";
import { projectBadge, projectTint } from "@ace/ui-core";
import { useMemo } from "react";
import { Icon } from "@/components/icon.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { MachineMark } from "@/components/ui/machine-label.tsx";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
} from "@/components/ui/context-menu.tsx";
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
import { useMachines } from "@/lib/machines.ts";
import { DeviceFilter } from "./device-filter.tsx";
import { useSidebarDevice } from "./device-filter-state.ts";
import { useProjects } from "./use-home-threads.ts";
import { useOrganizer, useOrganizerState } from "@/features/organize/index.ts";
import { AddProjectItem, ManageProjectItems } from "@/features/projects/index.ts";

const all = "\u0000all";

/**
 * The Threads panel's filter, in its own row under the title: "All projects" with a small
 * caret opens the project and device filter (it narrows all three tabs to one project or
 * device, offers actions for each project and ends with Add project). A project shows its mark
 * and name; a device shows its glyph and name; both show the mark and name, then ` · `, then
 * the glyph and name, truncated with the full text in the tooltip. Every project the daemon
 * lists is here, with or without threads, beside any project only threads still mention.
 */
export function ProjectFilter() {
  const organizer = useOrganizer();
  const { project } = useOrganizerState();
  const deviceId = useSidebarDevice();
  const device = useMachines().find((machine) => machine.id === deviceId);
  const withThreads = useProjects();
  const directory = useProjectDirectory();
  const { name } = directory;
  const projectName = project === null ? null : name(project);
  const label = projectName ?? "All projects";
  const fullTitle =
    projectName && device
      ? `${projectName} · ${device.name}`
      : (projectName ?? device?.name ?? "All projects");
  const total = withThreads.reduce((sum, p) => sum + p.threads, 0);
  const rows = useMemo(() => {
    const counts = new Map(withThreads.map((p) => [p.id, p.threads]));
    const ids = [...new Set([...directory.projects.map((p) => p.id), ...counts.keys()])].filter(
      (id) => !directory.isChat(id),
    );
    return ids
      .map((id) => ({ id, label: name(id), threads: counts.get(id) ?? 0 }))
      .toSorted((a, b) => a.label.localeCompare(b.label));
  }, [withThreads, directory, name]);

  return (
    <span className="flex min-w-0 flex-1">
      <Menu>
        <Tip label={fullTitle}>
          <MenuTrigger
            aria-label={`Project filter: ${label}${device ? `, Device: ${device.name}` : ""}`}
            className="group/filter flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2 text-md font-medium text-muted-foreground transition-colors duration-(--motion-fast) focus-ring hover:bg-hover hover:text-foreground aria-expanded:bg-active aria-expanded:text-foreground"
          >
            <span className="flex min-w-0 flex-1 items-center gap-1.5 text-left">
              {project !== null && (
                <ProjectMark
                  id={project}
                  badge={projectBadge({ id: project, name: projectName ?? project })}
                />
              )}
              {project !== null && <span className="min-w-0 truncate">{projectName}</span>}
              {project !== null && device && (
                <span aria-hidden className="shrink-0">
                  ·
                </span>
              )}
              {device && <MachineMark icon={device.icon} primary={device.primary} size={16} />}
              {device && <span className="min-w-0 truncate">{device.name}</span>}
              {project === null && !device && <span className="truncate">All projects</span>}
            </span>
            <CaretDownIcon aria-hidden size={12} className="shrink-0 text-muted-foreground" />
          </MenuTrigger>
        </Tip>
        <MenuContent align="end" className="max-h-[60vh] min-w-64 overflow-y-auto">
          <DeviceFilter />
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
          <MenuSeparator />
          <AddProjectItem />
        </MenuContent>
      </Menu>
    </span>
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
          {props.value === all ? (
            <Icon icon={FolderSimpleIcon} />
          ) : (
            <ProjectMark
              id={props.value}
              badge={projectBadge({ id: props.value, name: props.label })}
            />
          )}
        </span>
        {props.label}
        {/* The count stays put under the pointer: ⋯ has its own room beside it. */}
        <span className="ml-auto pl-4 text-xs text-subtle-foreground tabular-nums">
          {props.count}
        </span>
      </span>
    </MenuRadioItem>
  );
  if (!props.registered) return item;
  const actions = <ManageProjectItems projectId={props.value} name={props.label} />;
  return (
    <div className="group/project flex items-center">
      <ContextMenu>
        <ContextMenuTrigger render={<div className="flex-1" />}>{item}</ContextMenuTrigger>
        <ContextMenuContent aria-label={`Actions for ${props.label}`}>{actions}</ContextMenuContent>
      </ContextMenu>
      <MenuSub>
        <Tip label={`Actions for ${props.label}`}>
          <MenuSubTrigger
            aria-label={`Actions for ${props.label}`}
            className="w-auto px-2 opacity-0 group-hover/project:opacity-100 group-focus-within/project:opacity-100 [&>svg:last-child]:hidden"
          >
            <DotsThreeIcon aria-hidden size={16} />
          </MenuSubTrigger>
        </Tip>
        <MenuContent aria-label={`Actions for ${props.label}`}>{actions}</MenuContent>
      </MenuSub>
    </div>
  );
}
