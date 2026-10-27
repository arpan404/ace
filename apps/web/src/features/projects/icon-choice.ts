import { projectBadgeStyle, type ProjectIconChoice, type ProjectIconMode } from "@ace/ui-core";
import type { ProjectLook } from "@/components/project-mark.tsx";
import type { Project } from "@/lib/projects.ts";

export type IconMode = ProjectIconMode;
/** The icon a person is choosing in the project editor (`@ace/ui-core` project-edit). */
export type IconChoice = ProjectIconChoice;

/** The badge the choice draws, for the editor's live preview. */
export function lookOf(choice: IconChoice, project: Project | undefined): ProjectLook {
  switch (choice.mode) {
    case "auto":
      return { defaultIcon: project?.defaultIcon };
    case "image":
      return choice.image ? { icon: choice.image } : { badge: {} };
    default:
      return { badge: projectBadgeStyle(choice) };
  }
}
