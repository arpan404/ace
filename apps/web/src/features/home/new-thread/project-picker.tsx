import { ProjectImage } from "@/components/project-image.tsx";
import { useProjectIcon } from "@/lib/projects.ts";
import { CaretDownIcon, FolderSimpleIcon } from "@phosphor-icons/react";
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
import { composerStrip } from "@/features/thread/index.ts";

/**
 * The project a new thread starts in, on the environment strip below the composer: its name opens a
 * menu of the registered projects, with Add project at its foot.
 */
export function ProjectPicker(props: {
  projects: readonly string[];
  /** A project's name by id. */
  projectName(id: string): string;
  project: string | undefined;
  onProject(project: string): void;
}) {
  const iconFor = useProjectIcon();
  const value = props.project === undefined ? "a project" : props.projectName(props.project);
  return (
    <Menu>
      <MenuTrigger
        aria-label={`Project: ${props.project === undefined ? "Choose a project" : value}`}
        className={`${composerStrip} shrink-0 text-foreground`}
      >
        <ProjectImage
          icon={props.project ? iconFor(props.project) : undefined}
          fallback={
            <FolderSimpleIcon aria-hidden size={14} className="shrink-0 text-muted-foreground" />
          }
        />
        <span className="max-w-32 truncate">{value}</span>
        <CaretDownIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
      </MenuTrigger>
      <MenuContent side="top" align="start" className="max-h-[50vh] min-w-[220px] overflow-y-auto">
        <MenuGroup>
          <MenuLabel>Projects</MenuLabel>
          <MenuRadioGroup
            value={props.project ?? ""}
            onValueChange={(next) => props.onProject(String(next))}
          >
            {props.projects.map((id) => (
              <MenuRadioItem closeOnClick key={id} value={id} aria-label={props.projectName(id)}>
                <span className="flex items-center gap-2">
                  <ProjectImage
                    icon={iconFor(id)}
                    fallback={<FolderSimpleIcon aria-hidden size={14} />}
                  />
                  {props.projectName(id)}
                </span>
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
