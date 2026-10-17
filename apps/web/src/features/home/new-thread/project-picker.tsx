import { Suspense, useState } from "react";
import { CaretDownIcon, FolderSimpleIcon } from "@phosphor-icons/react";
import { projectBadge } from "@ace/ui-core";
import { ProjectMark } from "../row-parts.tsx";
import { useProjectDirectory } from "@/lib/projects.ts";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { composerStrip } from "@/features/thread/index.ts";

import type { Choice } from "./project-choices.tsx";

const DeferredChoices = deferredComponent(() =>
  import("./project-choices.tsx").then((module) => module.ProjectChoices),
);
const warm = () => void DeferredChoices.preload();

/**
 * The project a new thread starts in: the first control of the composer's top strip. Enter or
 * Space opens a searchable list; arrows move, Enter picks, Escape hands focus back to the
 * message.
 */
export function ProjectPicker(props: {
  projects: readonly string[];
  projectName(id: string): string;
  project: string | undefined;
  onProject(project: string): void;
  /** Where focus goes when the list closes: the message. */
  returnFocus(): HTMLElement | null;
}) {
  const [open, setOpen] = useState(false);
  const directory = useProjectDirectory();
  const byId = new Map(directory.projects.map((project) => [project.id, project]));
  const choices: Choice[] = props.projects.map((id) => {
    const metadata = byId.get(id);
    return {
      id,
      name: props.projectName(id),
      path: metadata?.path ?? "",
    };
  });
  const selected = choices.find((choice) => choice.id === props.project);
  const value = selected?.name ?? "Choose a project";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip label="The project it works in" side="top">
        <PopoverTrigger
          onPointerEnter={warm}
          onFocus={warm}
          aria-label={`Project: ${value}`}
          className={`${composerStrip} max-w-48 shrink-0 text-foreground`}
        >
          {selected ? (
            <ProjectMark id={selected.id} badge={projectBadge(selected)} />
          ) : (
            <FolderSimpleIcon aria-hidden size={14} className="shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 truncate">{value}</span>
          <CaretDownIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
        </PopoverTrigger>
      </Tip>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={10}
        aria-label="Choose project"
        className="flex w-[320px] min-w-0 flex-col p-0"
        initialFocus
        finalFocus={props.returnFocus}
      >
        <Suspense fallback={<ListSkeleton label="projects" shape="row" className="p-1.5" />}>
          {open && (
            <DeferredChoices.Component
              choices={choices}
              project={props.project}
              onProject={props.onProject}
              onClose={() => setOpen(false)}
            />
          )}
        </Suspense>
      </PopoverContent>
    </Popover>
  );
}
