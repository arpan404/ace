import { Suspense, useState } from "react";
import { CaretDownIcon, FolderPlusIcon, FolderSimpleIcon } from "@phosphor-icons/react";
import { useConnectionState } from "@ace/client-react";
import { projectBadge } from "@ace/ui-core";
import { ProjectMark } from "../row-parts.tsx";
import { useProjectDirectory } from "@/lib/projects.ts";
import { deferredComponent } from "@/lib/deferred-component.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.tsx";
import { Button } from "@/components/ui/button.tsx";
import { useProjectDialogs } from "@/features/projects/index.ts";
import { composerStrip, MenuPending } from "@/features/thread/index.ts";
import type { ProjectChoice } from "./project-choices.tsx";

/** The search list loads after New thread paints; the page warms it while idle. */
export const DeferredProjectChoices = deferredComponent(() =>
  import("./project-choices.tsx").then((module) => module.ProjectChoices),
);

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
  const [query, setQuery] = useState("");
  const directory = useProjectDirectory();
  const dialogs = useProjectDialogs();
  const reachable = useConnectionState() === "ready";
  const byId = new Map(directory.projects.map((project) => [project.id, project]));
  const choices: ProjectChoice[] = props.projects.map((id) => {
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
  const changeOpen = (next: boolean) => {
    setOpen(next);
    if (!next) setQuery("");
  };
  return (
    <Popover open={open} onOpenChange={changeOpen}>
      <PopoverTrigger
        aria-label={`${props.labelPrefix ?? "Project"}: ${props.project === undefined ? "Choose a project" : value}`}
        onPointerEnter={() => void DeferredProjectChoices.preload()}
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
        <Suspense fallback={<MenuPending />}>
          <DeferredProjectChoices.Component
            choices={choices}
            project={props.project}
            query={query}
            onQuery={setQuery}
            onPick={(project) => {
              props.onProject(project);
              changeOpen(false);
            }}
          />
        </Suspense>
        <div className="shrink-0 border-t p-1.5">
          <Button
            variant="ghost"
            className="w-full justify-start"
            disabled={!reachable}
            aria-label="Add project"
            onPointerEnter={dialogs.preload}
            onClick={() => {
              changeOpen(false);
              dialogs.open({ kind: "add", tab: "open" });
            }}
          >
            <FolderPlusIcon aria-hidden size={16} />
            Add project…
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
