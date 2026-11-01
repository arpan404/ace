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
 * The Threads panel's filter, beside its title: "Everywhere" with a small caret, which opens the
 * project and device filter (it narrows all three tabs to one project or device, offers actions
 * for each project and ends with Add project). While a filter is on, the project's name (else
 * the device's) takes Everywhere's place, a device adding its mark. Every project the daemon
 * lists is here, with or without threads, beside any project only threads still mention.
 */
export function ProjectFilter() {
  const organizer = useOrganizer();
  const { project } = useOrganizerState();
  const deviceId = useSidebarDevice();
  const device = useMachines().find((machine) => machine.id === deviceId);
  const characters = Array.from(device?.name ?? "");
  const deviceName =
    characters.length > 15 ? `${characters.slice(0, 15).join("").trimEnd()}…` : device?.name;
  const withThreads = useProjects();
  const directory = useProjectDirectory();
  const { name } = directory;
  const label = project === null ? "All projects" : name(project);
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
    <Menu>
      <Tip label={device ? `${label} on ${device.name}` : "Filter threads"}>
        <MenuTrigger
          aria-label={`Project filter: ${label}${device ? `, Device: ${device.name}` : ""}`}
          className="group/filter inline-flex h-7 min-w-0 max-w-full items-center gap-1 rounded-md px-2 text-meta font-medium text-muted-foreground focus-ring transition-colors duration-(--motion-fast) hover:bg-hover hover:text-foreground aria-expanded:bg-active aria-expanded:text-foreground"
        >
          {device && <MachineMark icon={device.icon} primary={device.primary} />}
          <span
            className="min-w-0 truncate"
            data-selected-device-name={project === null && device ? "" : undefined}
          >
            {project !== null ? label : device ? deviceName : "Everywhere"}
          </span>
          <CaretDownIcon aria-hidden size={10} className="shrink-0" />
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
        <span className="ml-auto pl-4 group-hover/project:opacity-0 group-focus-within/project:opacity-0 text-xs text-subtle-foreground">
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
