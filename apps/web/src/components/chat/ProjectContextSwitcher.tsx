import { type ProjectId } from "@ace/contracts";
import { ChevronDownIcon } from "lucide-react";
import { memo, useMemo } from "react";

import { orderItemsByPreferredIds } from "~/lib/sidebar";
import { cn } from "~/lib/utils";
import { useStore } from "~/store";
import type { Project } from "~/types";
import { useUiStateStore } from "~/uiStateStore";

import { ProjectAvatar } from "../ProjectAvatar";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuTrigger,
} from "../ui/menu";

type ProjectContextProject = Pick<Project, "cwd" | "icon" | "id" | "name">;

interface ProjectContextSwitcherProps {
  activeProjectId: ProjectId | null;
  onSelectProject: (projectId: ProjectId) => void;
  variant?: "compact" | "hero";
  className?: string;
  emptyLabel?: string;
}

export const ProjectContextSwitcher = memo(function ProjectContextSwitcher({
  activeProjectId,
  onSelectProject,
  variant = "compact",
  className,
  emptyLabel = "Choose project",
}: ProjectContextSwitcherProps) {
  const projects = useStore((store) => store.projects);
  const projectOrder = useUiStateStore((store) => store.projectOrder);
  const orderedProjects = useMemo<readonly ProjectContextProject[]>(
    () =>
      orderItemsByPreferredIds({
        items: projects.filter((project) => project.archivedAt === null),
        preferredIds: projectOrder,
        getId: (project) => project.id,
      }),
    [projectOrder, projects],
  );
  const activeProject =
    orderedProjects.find((project) => project.id === activeProjectId) ?? orderedProjects[0] ?? null;
  const triggerLabel = activeProject ? `Switch project from ${activeProject.name}` : emptyLabel;

  return (
    <Menu>
      <MenuTrigger
        render={
          variant === "hero" ? (
            <button
              type="button"
              aria-label={triggerLabel}
              className={cn(
                "group inline-flex max-w-full cursor-pointer flex-col items-center rounded-[1.5rem] px-5 py-3 text-center transition-colors hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64",
                className,
              )}
            />
          ) : (
            <Button
              aria-label={triggerLabel}
              className={cn(
                "min-w-0 max-w-60 justify-start gap-1.5 rounded-full border-border bg-background px-2.5 font-medium text-foreground hover:bg-accent hover:text-foreground",
                className,
              )}
              size="xs"
              variant="outline"
            />
          )
        }
        disabled={activeProject === null}
      >
        {activeProject ? (
          variant === "hero" ? (
            <>
              <span className="inline-flex max-w-full items-center gap-2 text-2xl font-semibold tracking-tight text-foreground/90 sm:text-3xl">
                <ProjectAvatar project={activeProject} className="size-5 sm:size-5.5" />
                <span className="truncate">{activeProject.name}</span>
                <ChevronDownIcon className="size-4 shrink-0 text-muted-foreground/60 transition-transform duration-150 group-hover:translate-y-px" />
              </span>
              <span className="mt-1 max-w-[min(72vw,34rem)] truncate font-mono text-[11px] text-muted-foreground/58 sm:text-xs">
                {activeProject.cwd}
              </span>
            </>
          ) : (
            <>
              <ProjectAvatar project={activeProject} className="size-3.5" />
              <span className="min-w-0 truncate">{activeProject.name}</span>
              <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground/60" />
            </>
          )
        ) : (
          <>
            <span
              className={variant === "hero" ? "text-xl font-medium text-muted-foreground/68" : ""}
            >
              {emptyLabel}
            </span>
            {variant === "compact" ? (
              <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground/45" />
            ) : null}
          </>
        )}
      </MenuTrigger>

      {orderedProjects.length > 0 ? (
        <MenuPopup
          align={variant === "hero" ? "center" : "start"}
          className="w-[min(28rem,calc(100vw-2rem))]"
          listMaxHeight="min(24rem,70vh)"
          sideOffset={variant === "hero" ? 10 : 6}
        >
          <MenuGroup>
            <MenuGroupLabel>Projects</MenuGroupLabel>
            <MenuRadioGroup
              value={activeProject?.id}
              onValueChange={(value) => onSelectProject(value as ProjectId)}
            >
              {orderedProjects.map((project) => (
                <MenuRadioItem key={project.id} value={project.id} className="min-h-11 py-1.5">
                  <span className="flex min-w-0 items-center gap-2.5">
                    <ProjectAvatar project={project} className="size-4" />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate font-medium">{project.name}</span>
                      <span className="truncate font-mono text-[11px] text-muted-foreground/70">
                        {project.cwd}
                      </span>
                    </span>
                  </span>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        </MenuPopup>
      ) : null}
    </Menu>
  );
});
