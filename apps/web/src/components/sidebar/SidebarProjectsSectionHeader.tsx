import { IconArrowsDiagonalMinimize2, IconFolderPlus } from "@tabler/icons-react";
import { ChevronRightIcon } from "lucide-react";
import type { SidebarProjectSortOrder, SidebarThreadSortOrder } from "@ace/contracts/settings";

import { ProjectSortMenu } from "./ProjectSortMenu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function SidebarProjectsSectionHeader(props: {
  addProjectShortcutLabel: string | null;
  canCollapseVisibleProjects: boolean;
  projectSortOrder: SidebarProjectSortOrder;
  projectsSectionExpanded: boolean;
  shouldShowProjectPathEntry: boolean;
  threadSortOrder: SidebarThreadSortOrder;
  onCollapseVisibleProjects: () => void;
  onProjectSortOrderChange: (sortOrder: SidebarProjectSortOrder) => void;
  onThreadSortOrderChange: (sortOrder: SidebarThreadSortOrder) => void;
  onToggleAddProject: () => void;
  onToggleProjectsSection: () => void;
}) {
  return (
    <div className="mb-1.5 flex items-center justify-between pl-2 pr-1.5">
      <button
        type="button"
        className="group/section-header flex h-5 min-w-0 flex-1 cursor-pointer items-center gap-1.5 bg-transparent text-left"
        aria-expanded={props.projectsSectionExpanded}
        onClick={props.onToggleProjectsSection}
      >
        <span className="text-xs font-medium uppercase tracking-wider text-muted-foreground transition-colors group-hover/section-header:text-foreground">
          Projects
        </span>
        <ChevronRightIcon
          className={`size-4 text-muted-foreground/45 opacity-0 transition-[opacity,transform,color] duration-150 group-hover/section-header:text-foreground group-hover/section-header:opacity-100 ${
            props.projectsSectionExpanded ? "rotate-90" : ""
          }`}
        />
      </button>
      <div className="flex items-center gap-1">
        {props.canCollapseVisibleProjects ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label="Collapse open projects"
                  className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                  onClick={props.onCollapseVisibleProjects}
                />
              }
            >
              <IconArrowsDiagonalMinimize2 className="size-4" />
            </TooltipTrigger>
            <TooltipPopup side="right">Collapse open projects</TooltipPopup>
          </Tooltip>
        ) : null}
        <ProjectSortMenu
          projectSortOrder={props.projectSortOrder}
          threadSortOrder={props.threadSortOrder}
          onProjectSortOrderChange={props.onProjectSortOrderChange}
          onThreadSortOrderChange={props.onThreadSortOrderChange}
        />
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={props.shouldShowProjectPathEntry ? "Cancel add project" : "Add project"}
                aria-pressed={props.shouldShowProjectPathEntry}
                className="inline-flex size-6 cursor-pointer items-center justify-center rounded-md text-muted-foreground/60 transition-colors hover:bg-accent hover:text-foreground"
                onClick={props.onToggleAddProject}
              />
            }
          >
            <IconFolderPlus className="size-4" />
          </TooltipTrigger>
          <TooltipPopup side="right">
            {props.shouldShowProjectPathEntry
              ? "Cancel add project"
              : props.addProjectShortcutLabel
                ? `Add project (${props.addProjectShortcutLabel})`
                : "Add project"}
          </TooltipPopup>
        </Tooltip>
      </div>
    </div>
  );
}
