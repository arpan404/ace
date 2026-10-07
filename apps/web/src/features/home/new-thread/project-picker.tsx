import { CaretDownIcon } from "@phosphor-icons/react";
import {
  Menu,
  MenuContent,
  MenuGroup,
  MenuLabel,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "@/components/ui/menu.tsx";
import { AddProjectItem } from "@/features/projects/index.ts";

/**
 * The project a new thread starts in, as part of the page's question ("What should we work on
 * in ace?"): the name is a quiet menu of the registered projects, with Add project at its foot.
 */
export function ProjectPicker(props: {
  projects: readonly string[];
  /** A project's name by id. */
  projectName(id: string): string;
  project: string | undefined;
  onProject(project: string): void;
}) {
  const value = props.project === undefined ? "a project" : props.projectName(props.project);
  return (
    <Menu>
      <MenuTrigger
        aria-label={`Project: ${props.project === undefined ? "Choose a project" : value}`}
        className="-mx-1 inline-flex items-center gap-1 rounded-md px-1 text-foreground outline-none transition-colors duration-(--dur-1) hover:bg-accent focus-visible:shadow-[0_0_0_2px_var(--ring)] aria-expanded:bg-accent"
      >
        <span className="underline decoration-dotted underline-offset-4">{value}</span>
        <CaretDownIcon aria-hidden size={14} className="text-subtle-foreground" />
      </MenuTrigger>
      <MenuContent align="start" className="max-h-[50vh] min-w-[220px] overflow-y-auto">
        <MenuGroup>
          <MenuLabel>Projects</MenuLabel>
          <MenuRadioGroup
            value={props.project ?? ""}
            onValueChange={(next) => props.onProject(String(next))}
          >
            {props.projects.map((id) => (
              <MenuRadioItem key={id} value={id} aria-label={props.projectName(id)}>
                {props.projectName(id)}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
        </MenuGroup>
        {props.projects.length > 0 && <MenuSeparator />}
        <AddProjectItem />
      </MenuContent>
    </Menu>
  );
}
