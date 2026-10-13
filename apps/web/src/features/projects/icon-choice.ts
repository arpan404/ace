import type { BadgeColor, ProjectBadgeStyle, ProjectGlyph } from "@ace/protocol";
import type { ProjectLook } from "@/components/project-mark.tsx";
import type { Project } from "@/lib/projects.ts";

export type IconMode = "auto" | "initials" | "glyph" | "image";

/** The icon a person is choosing in the project editor. */
export interface IconChoice {
  mode: IconMode;
  /** Unset keeps the tint that stays with the project id. */
  color: BadgeColor | undefined;
  glyph: ProjectGlyph;
  /** The custom image, once one is picked. */
  image: string | undefined;
}

/** What the project shows now, as a choice to start the editor from. */
export function iconChoiceOf(project: Project | undefined): IconChoice {
  const badge = project?.badge;
  const image = project?.icon ?? undefined;
  return {
    mode: image ? "image" : badge?.glyph ? "glyph" : badge ? "initials" : "auto",
    color: badge?.color,
    glyph: badge?.glyph ?? "code",
    image,
  };
}

function style(choice: IconChoice): ProjectBadgeStyle {
  return {
    ...(choice.color ? { color: choice.color } : {}),
    ...(choice.mode === "glyph" ? { glyph: choice.glyph } : {}),
  };
}

/**
 * The `workspace.update` fields a choice saves. Image mode without a picked image changes
 * nothing; every other mode clears what it doesn't use.
 */
export function iconEdit(choice: IconChoice): {
  icon?: string | null;
  badge?: ProjectBadgeStyle | null;
} {
  switch (choice.mode) {
    case "auto":
      return { icon: null, badge: null };
    case "image":
      return choice.image ? { icon: choice.image, badge: null } : {};
    default:
      return { icon: null, badge: style(choice) };
  }
}

/** The badge the choice draws, for the editor's live preview. */
export function lookOf(choice: IconChoice, project: Project | undefined): ProjectLook {
  switch (choice.mode) {
    case "auto":
      return { defaultIcon: project?.defaultIcon };
    case "image":
      return choice.image ? { icon: choice.image } : { badge: {} };
    default:
      return { badge: style(choice) };
  }
}
