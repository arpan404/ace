import { Suspense, useState } from "react";
import { CaretDownIcon, FolderSimpleIcon } from "@phosphor-icons/react";
import { projectBadge } from "@ace/ui-core";
import { ProjectMark } from "../row-parts.tsx";
import { useProjectDirectory } from "@/lib/projects.ts";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { composerStrip } from "@/features/thread/index.ts";

import type { Choice } from "./project-choices.tsx";

const DeferredChoices = deferredComponent(() =>
  import("./project-choices.tsx").then((module) => module.ProjectChoices),
);
const warm = () => void DeferredChoices.preload();

/** One searchable registered-project picker shared by the heading and setup strip. */
export function ProjectPicker(props: {
  variant?: "inline";
  labelPrefix?: string;
  projects: readonly string[];
  projectName(id: string): string;
  project: string | undefined;
  onProject(project: string): void;
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
      icon: metadata?.icon ?? metadata?.defaultIcon,
    };
  });
  const selected = choices.find((choice) => choice.id === props.project);
  const value = selected?.name ?? "a project";
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        onPointerEnter={warm}
        onFocus={warm}
        aria-label={`${props.labelPrefix ?? "Project"}: ${props.project === undefined ? "Choose a project" : value}`}
        className={
          props.variant === "inline"
            ? "inline-flex min-h-7 min-w-0 max-w-full items-center gap-1 rounded-sm px-1 font-normal text-foreground underline decoration-border underline-offset-4 outline-none hover:decoration-foreground focus-visible:bg-accent"
            : `${composerStrip} shrink-0 text-foreground`
        }
      >
        {props.variant !== "inline" &&
          (selected ? (
            <ProjectMark badge={projectBadge(selected)} icon={selected.icon} />
          ) : (
            <FolderSimpleIcon aria-hidden size={14} className="shrink-0 text-muted-foreground" />
          ))}
        <span className={props.variant === "inline" ? "max-w-64 truncate" : "max-w-32 truncate"}>
          {value}
        </span>
        <CaretDownIcon aria-hidden size={12} className="shrink-0 text-subtle-foreground" />
      </PopoverTrigger>
      <PopoverContent
        side={props.variant === "inline" ? "bottom" : "top"}
        align="start"
        aria-label="Choose project"
        className="flex w-[320px] min-w-0 flex-col p-0"
        initialFocus
      >
        <Suspense
          fallback={
            <div className="grid h-48 place-items-center">
              <Spinner label="Loading projects" />
            </div>
          }
        >
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
