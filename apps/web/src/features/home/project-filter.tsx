import { CaretDownIcon, FolderSimpleIcon } from "@phosphor-icons/react";
import { Icon } from "@/components/icon.tsx";
import {
  Menu,
  MenuContent,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { useProjects } from "./use-home-threads.ts";
import { useOrganizer, useOrganizerState } from "./use-organizer.ts";

const all = "\u0000all";

/** "All projects ▾" in the Threads header: narrow Home to one project. */
export function ProjectFilter() {
  const organizer = useOrganizer();
  const { project } = useOrganizerState();
  const projects = useProjects();
  const total = projects.reduce((sum, p) => sum + p.threads, 0);
  return (
    <Menu>
      <MenuTrigger
        aria-label={`Project filter: ${project ?? "All projects"}`}
        className="inline-flex h-[26px] max-w-[140px] items-center gap-1 rounded-[7px] pr-2 pl-[9px] text-sm font-medium text-muted-foreground outline-none transition-colors duration-(--dur-1) hover:bg-sidebar-accent hover:text-foreground aria-expanded:bg-sidebar-accent aria-expanded:text-foreground"
      >
        <span className="truncate">{project ?? "All projects"}</span>
        <CaretDownIcon aria-hidden size={14} className="shrink-0" />
      </MenuTrigger>
      <MenuContent align="end" className="min-w-[220px]">
        <MenuRadioGroup
          value={project ?? all}
          onValueChange={(value) =>
            organizer.setProject(typeof value === "string" && value !== all ? value : null)
          }
        >
          <ProjectItem value={all} label="All projects" count={total} />
          {projects.length > 0 && <MenuSeparator />}
          {projects.map((p) => (
            <ProjectItem key={p.id} value={p.id} label={p.id} count={p.threads} />
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

function ProjectItem(props: { value: string; label: string; count: number }) {
  return (
    <MenuRadioItem value={props.value} aria-label={props.label}>
      <span className="flex items-center gap-[9px]">
        <Icon icon={FolderSimpleIcon} className="text-muted-foreground" />
        {props.label}
        <span className="ml-auto pl-4 text-xs text-subtle-foreground">{props.count}</span>
      </span>
    </MenuRadioItem>
  );
}
