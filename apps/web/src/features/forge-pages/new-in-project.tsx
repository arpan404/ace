import { projectBadge } from "@ace/ui-core";
import { ProjectMark } from "@/components/project-mark.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";

/**
 * A list's one action ("New pull request", "New issue"): with one project shown it opens in that
 * project; with several it asks which first.
 */
export function NewInProject(props: {
  label: string;
  projects: readonly string[];
  name(id: string): string;
  onPick(project: string): void;
}) {
  const [only] = props.projects;
  if (!only) return null;
  if (props.projects.length === 1)
    return (
      <Button size="sm" onClick={() => props.onPick(only)}>
        {props.label}
      </Button>
    );
  return (
    <Menu>
      <MenuTrigger render={<Button size="sm" />}>{props.label}</MenuTrigger>
      <MenuContent align="end" className="max-h-80 min-w-52 overflow-y-auto">
        {props.projects.map((id) => (
          <MenuItem
            key={id}
            icon={<ProjectMark id={id} badge={projectBadge({ id, name: props.name(id) })} />}
            onClick={() => props.onPick(id)}
          >
            {props.name(id)}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
