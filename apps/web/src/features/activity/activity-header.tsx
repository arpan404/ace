import { BellSimpleIcon, CheckIcon, FunnelSimpleIcon } from "@phosphor-icons/react";
import { useMemo } from "react";
import { Icon } from "@/components/icon.tsx";
import { Button } from "@/components/ui/button.tsx";
import { IconButton } from "@/components/ui/icon-button.tsx";
import {
  Menu,
  MenuContent,
  MenuItem,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { useAutomationRuns } from "@/features/automations/index.ts";
import { useActivityState } from "./activity-state.tsx";
import { useFeed, useFeedSource } from "./feed-source.ts";
import { useWorkspaces } from "@/features/shell/index.ts";

const allProjects = "*";

/** Header actions: Mark all read, and the project filter shared by the feed and the cards. */
export function ActivityActions() {
  const feed = useFeed();
  const source = useFeedSource();
  const runs = useAutomationRuns().data;
  const unread = useMemo(
    () => [
      ...feed.events
        .filter((event) => event.kind !== "escalation" && !feed.read.has(event.id))
        .map((event) => event.id),
      ...(runs ?? []).filter((run) => !feed.read.has(run.id)).map((run) => run.id),
    ],
    [feed, runs],
  );
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={!unread.length}
        onClick={() => source.markRead(unread)}
      >
        <Icon icon={CheckIcon} size={14} />
        Mark all read
      </Button>
      <ProjectFilter />
    </>
  );
}

function ProjectFilter() {
  const { project, setProject } = useActivityState();
  const projects = useProjects();
  return (
    <Menu>
      <MenuTrigger
        render={
          <IconButton
            icon={FunnelSimpleIcon}
            label={project ? `Filter: ${project}` : "Filter"}
            pressed={project !== undefined}
          />
        }
      />
      <MenuContent align="end">
        <MenuRadioGroup
          value={project ?? allProjects}
          onValueChange={(value: string) => setProject(value === allProjects ? undefined : value)}
        >
          <MenuLabel>Project</MenuLabel>
          <MenuRadioItem value={allProjects}>All projects</MenuRadioItem>
          {projects.map((name) => (
            <MenuRadioItem key={name} value={name}>
              {name}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
      </MenuContent>
    </Menu>
  );
}

/** Projects with threads on this daemon, plus any the feed mentions. */
function useProjects(): string[] {
  const workspaces = useWorkspaces();
  const { events } = useFeed();
  return useMemo(
    () => [...new Set([...workspaces, ...events.map((event) => event.project)])].toSorted(),
    [workspaces, events],
  );
}

/** The ⋯ menu beside the title. */
export function ActivityMenu(props: { onNotificationSettings(): void }) {
  return (
    <MenuItem
      icon={<Icon icon={BellSimpleIcon} size={14} />}
      onClick={props.onNotificationSettings}
    >
      Toast settings…
    </MenuItem>
  );
}
