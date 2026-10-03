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
import { useProjectChoices } from "@/lib/projects.ts";

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
  const { ids: projects, name } = useProjects();
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
        <MenuRadioGroup
          value={project ?? allProjects}
          onValueChange={(value: string) => setProject(value === allProjects ? undefined : value)}
        >
          <MenuLabel>Project</MenuLabel>
          <MenuRadioItem value={allProjects}>All projects</MenuRadioItem>
          {projects.map((id) => (
            <MenuRadioItem key={id} value={id}>
              {name(id)}
            </MenuRadioItem>
          ))}
        </MenuRadioGroup>
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
