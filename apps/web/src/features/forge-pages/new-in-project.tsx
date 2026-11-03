import { projectBadge } from "@ace/ui-core";
import { ProjectMark } from "@/components/project-mark.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Menu, MenuContent, MenuItem, MenuTrigger } from "@/components/ui/menu.tsx";

/** Its full words while the bar has room; just "New" in a narrow bar, so it never wraps. */
function Words(props: { label: string }) {
  return (
    <>
      <span className="@max-[640px]/bar:hidden">{props.label}</span>
      <span aria-hidden className="hidden @max-[640px]/bar:inline">
        New
      </span>
    </>
  );
}

/**
 * A list's one action ("New pull request", "New issue", "New" when the bar is narrow): with one
 * project shown it opens in that project; with several it asks which first.
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
      <Button
        size="sm"
        variant="primary"
        aria-label={props.label}
        onClick={() => props.onPick(only)}
      >
        <Words label={props.label} />
      </Button>
    );
  return (
    <Menu>
      <MenuTrigger render={<Button size="sm" variant="primary" aria-label={props.label} />}>
        <Words label={props.label} />
      </MenuTrigger>
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
