import { Suspense, useState } from "react";
import { useProjectDirectory } from "@/lib/projects.ts";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { ListSkeleton } from "@/components/ui/skeleton.tsx";
import { Tip } from "@/components/ui/tooltip.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";

import type { Choice } from "./project-choices.tsx";
import { chatChoice } from "./chat-project.ts";

const DeferredChoices = deferredComponent(() =>
  import("./project-choices.tsx").then((module) => module.ProjectChoices),
);
const warm = () => void DeferredChoices.preload();

/**
 * The project a new thread starts in: its name, inline in the page's question above the
 * composer. Enter or Space opens a searchable list; arrows move, Enter picks, Escape hands focus
 * back to the message.
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
  const chat = props.project === chatChoice;
  const value = chat ? "without a project" : (selected?.name ?? "Choose a project");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tip label="Change project" side="top">
        <PopoverTrigger
          onPointerEnter={warm}
          onFocus={warm}
          aria-label={chat ? "Project: none" : `Project: ${value}`}
          className="inline max-w-full rounded-sm text-foreground underline decoration-muted-foreground/60 decoration-dotted decoration-2 underline-offset-[0.2em] transition-colors duration-(--motion-fast) focus-ring hover:decoration-foreground data-popup-open:decoration-foreground"
        >
          {value}
        </PopoverTrigger>
      </Tip>
      <PopoverContent
        side="bottom"
        align="center"
        sideOffset={8}
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
