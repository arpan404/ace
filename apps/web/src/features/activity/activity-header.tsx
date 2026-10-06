import {
  BellSimpleIcon,
  ChecksIcon,
  FolderSimpleIcon,
  FunnelSimpleIcon,
  XIcon,
} from "@phosphor-icons/react";
import { useMemo } from "react";
import { Icon } from "@/components/icon.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuSub,
  MenuSubTrigger,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { useActivityState } from "./activity-state.tsx";
import { useFeed } from "./feed-source.ts";
import { useMarkAllRead } from "./use-mark-all-read.ts";
import { useProjectChoices } from "@/lib/projects.ts";

const allProjects = "*";

/** Header actions: the active project filter as a chip (× clears it), and the filter menu. */
export function ActivityActions() {
  const { project, setProject } = useActivityState();
  const { name } = useProjects();
  return (
    <>
      {project !== undefined && (
        <span className="inline-flex h-7 items-center gap-1 rounded-md bg-secondary pr-0.5 pl-2.5 text-sm">
          {name(project)}
          <IconButton
            icon={XIcon}
            size="sm"
            label={`Clear the ${name(project)} filter`}
            tooltip={false}
            onClick={() => setProject(undefined)}
          />
        </span>
      )}
      <ProjectFilter />
    </>
  );
}

function ProjectRadios() {
  const { project, setProject } = useActivityState();
  const { ids: projects, name } = useProjects();
  return (
    <MenuRadioGroup
      value={project ?? allProjects}
      onValueChange={(value: string) => setProject(value === allProjects ? undefined : value)}
    >
      <MenuLabel>Project</MenuLabel>
      <MenuRadioItem value={allProjects} closeOnClick>
        All projects
      </MenuRadioItem>
      {projects.map((id) => (
        <MenuRadioItem key={id} value={id} closeOnClick>
          {name(id)}
        </MenuRadioItem>
      ))}
    </MenuRadioGroup>
  );
}

function ProjectFilter() {
  const { project } = useActivityState();
  const { name } = useProjects();
  return (
    <Menu>
      <MenuTrigger
        render={
          <IconButton
            icon={FunnelSimpleIcon}
            label={project ? `Filter: ${name(project)}` : "Filter"}
            pressed={project !== undefined}
          />
        }
      />
      <MenuContent align="end">
        <ProjectRadios />
      </MenuContent>
    </Menu>
  );
}

/** Every project on this daemon, plus any the feed mentions. */
function useProjects() {
  const { events } = useFeed();
  const mentioned = useMemo(() => events.map((event) => event.project), [events]);
  return useProjectChoices(mentioned);
}

/**
 * The ⋯ menu beside the title: everything the header holds, so a narrow window that folds the
 * header actions into it loses nothing.
 */
export function ActivityMenu(props: { onNotificationSettings(): void }) {
  const { unread, markAll } = useMarkAllRead();
  return (
    <>
      <MenuItem icon={<Icon icon={ChecksIcon} />} disabled={!unread} onClick={markAll}>
        Mark all read
      </MenuItem>
      <MenuSub>
        <MenuSubTrigger icon={<Icon icon={FolderSimpleIcon} />}>Project</MenuSubTrigger>
        <MenuContent side="right" align="start" sideOffset={4}>
          <ProjectRadios />
        </MenuContent>
      </MenuSub>
      <MenuSeparator />
      <MenuItem icon={<Icon icon={BellSimpleIcon} />} onClick={props.onNotificationSettings}>
        Notification settings…
      </MenuItem>
    </>
  );
}
